import { RPUSBController } from '../peripherals/usb';
import { FIFO } from '../utils/fifo';
import { DataDirection, DescriptorType, SetupRecipient, SetupType } from './interfaces';
import {
  createSetupPacket,
  getDescriptorPacket,
  setDeviceAddressPacket,
  setDeviceConfigurationPacket,
} from './setup';

// CDC stuff
const CDC_REQUEST_SET_CONTROL_LINE_STATE = 0x22;

const CDC_DTR = 1 << 0;
const CDC_RTS = 1 << 1;

const CDC_DATA_CLASS = 10;
const ENDPOINT_BULK = 2;

const TX_FIFO_SIZE = 512;

const ENDPOINT_ZERO = 0;
const CONFIGURATION_DESCRIPTOR_SIZE = 9;

// Config descriptors larger than this never complete enumeration.
const MAX_DESCRIPTOR_SIZE = 256;

// Fixed scratch for OUT transfers (largest buffer-control length is 0x3ff).
const MAX_PACKET_SIZE = 1024;

/** Extracts a CDC data interface's bulk endpoint numbers from a config
 * descriptor; returns them packed as `in | (out << 8)`, with 0xff for
 * not-found (endpoint numbers are 0..15). */
export function extractEndpointNumbers(descriptors: Uint8Array, count: number): number {
  let index = 0;
  let foundInterface = false;
  let inEndpoint = -1;
  let outEndpoint = -1;
  while (index < count) {
    const len = descriptors[index];
    if (len < 2 || count < index + len) {
      break;
    }
    const type = descriptors[index + 1];
    if (type === DescriptorType.Interface && len === 9) {
      const numEndpoints = descriptors[index + 4];
      const interfaceClass = descriptors[index + 5];
      foundInterface = numEndpoints === 2 && interfaceClass === CDC_DATA_CLASS;
    }
    if (foundInterface && type === DescriptorType.Endpoint && len === 7) {
      const address = descriptors[index + 2];
      const attributes = descriptors[index + 3];
      if ((attributes & 0x3) === ENDPOINT_BULK) {
        if (address & 0x80) {
          inEndpoint = address & 0xf;
        } else {
          outEndpoint = address & 0xf;
        }
      }
    }
    index += descriptors[index];
  }
  return (inEndpoint & 0xff) | ((outEndpoint & 0xff) << 8);
}

export class USBCDC {
  readonly txFIFO = new FIFO(TX_FIFO_SIZE);

  // Buffers come from the controller's alarm pool, valid only for the duration
  // of the callback.
  onSerialData?: (buffer: Uint8Array, length: number) => void;
  onDeviceConnected?: () => void;

  private initialized = false;
  private descriptorsSize = 0;
  private readonly descriptors = new Uint8Array(MAX_DESCRIPTOR_SIZE);
  private descriptorsCount = 0;
  private outEndpoint = -1;
  private inEndpoint = -1;
  /** When non-null, the firmware armed the OUT endpoint but txFIFO was empty.
   * The read is deferred until sendSerialByte pushes data, matching real
   * hardware where AVAILABLE stays set until a host packet arrives. */
  private pendingOutReadSize = 0;
  private readonly outScratch = new Uint8Array(MAX_PACKET_SIZE);

  constructor(readonly usb: RPUSBController) {
    this.usb.onUSBEnabled = () => {
      this.usb.resetDevice();
    };
    this.usb.onResetReceived = () => {
      this.usb.sendSetupPacket(setDeviceAddressPacket(1));
    };
    this.usb.onEndpointWrite = (endpoint, buffer, length) => {
      if (endpoint === ENDPOINT_ZERO && length === 0) {
        if (this.descriptorsSize === 0) {
          this.usb.sendSetupPacket(
            getDescriptorPacket(DescriptorType.Configration, CONFIGURATION_DESCRIPTOR_SIZE)
          );
        }
        // Acknowledgement
        else if (!this.initialized) {
          this.cdcSetControlLineState();
          this.onDeviceConnected?.();
        }
      }
      if (endpoint === ENDPOINT_ZERO && length > 1) {
        if (
          length === CONFIGURATION_DESCRIPTOR_SIZE &&
          buffer[1] === DescriptorType.Configration &&
          this.descriptorsSize === 0
        ) {
          this.descriptorsSize = (buffer[3] << 8) | buffer[2];
          this.usb.sendSetupPacket(
            getDescriptorPacket(DescriptorType.Configration, this.descriptorsSize)
          );
        } else if (this.descriptorsSize !== 0 && this.descriptorsCount < this.descriptorsSize) {
          for (let i = 0; i < length && this.descriptorsCount < MAX_DESCRIPTOR_SIZE; i++) {
            this.descriptors[this.descriptorsCount++] = buffer[i];
          }
        }
        if (this.descriptorsSize !== 0 && this.descriptorsCount === this.descriptorsSize) {
          const endpoints = extractEndpointNumbers(this.descriptors, this.descriptorsCount);
          this.inEndpoint = endpoints & 0xff;
          this.outEndpoint = (endpoints >>> 8) & 0xff;

          // Now configure the device
          this.usb.sendSetupPacket(setDeviceConfigurationPacket(1));
        }
      }
      if (endpoint === this.inEndpoint) {
        this.onSerialData?.(buffer, length);
      }
    };
    this.usb.onEndpointRead = (endpoint, size) => {
      if (endpoint === this.outEndpoint) {
        if (this.txFIFO.itemCount > 0) {
          this.deliverOutData(size);
        } else {
          this.pendingOutReadSize = size;
        }
      }
    };
  }

  private cdcSetControlLineState(value = CDC_DTR | CDC_RTS, interfaceNumber = 0) {
    this.usb.sendSetupPacket(
      createSetupPacket({
        dataDirection: DataDirection.HostToDevice,
        type: SetupType.Class,
        recipient: SetupRecipient.Device,
        bRequest: CDC_REQUEST_SET_CONTROL_LINE_STATE,
        wValue: value,
        wIndex: interfaceNumber,
        wLength: 0,
      })
    );
    this.initialized = true;
  }

  private deliverOutData(size: number) {
    const length = Math.min(size, this.txFIFO.itemCount);
    for (let i = 0; i < length; i++) {
      this.outScratch[i] = this.txFIFO.pull();
    }
    this.usb.endpointReadDone(this.outEndpoint, this.outScratch, length);
  }

  sendSerialByte(data: number) {
    this.txFIFO.push(data);
    if (this.pendingOutReadSize > 0) {
      const size = this.pendingOutReadSize;
      this.pendingOutReadSize = 0;
      this.deliverOutData(size);
    }
  }
}
