import binascii

binFile = open('/tmp/bootrom-combined.bin','rb')
binaryData = binFile.read(32*1024)
hex = binascii.hexlify(binaryData, ",", 4).decode("UTF-8")
hex = [val[6:8] + val[4:6] + val[2:4] + val[0:2] for val in hex.split(",")]
print("// RP2350 bootrom binary, built from https://github.com/raspberrypi/pico-bootrom-rp2350/releases/")
print("// revision: A2 (sha1 73d193dceddbd82d2235ef42d9173de8d353e703 bootrom-combined.bin)")
print()
print("export const bootrom_rp2350_A2 = new Uint32Array([")
print("  0x" + ",\n  0x".join(hex))
print("])")
