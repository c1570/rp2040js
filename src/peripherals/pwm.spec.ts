import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDriver } from '../../test-utils/create-test-driver';
import { ICortexTestDriver } from '../../test-utils/test-driver';
import { RP2040TestDriver } from '../../test-utils/test-driver-rp2040';

describe('PWM', () => {
  let cpu: ICortexTestDriver;

  beforeEach(async () => {
    cpu = await createTestDriver();
  });

  afterEach(async () => {
    await cpu.tearDown();
  });

  it('should not hang', async () => {
    await cpu.writeUint32(0x4005008c,0);
    await cpu.writeUint32(0x40050094,0);
    await cpu.writeUint32(0x40050098,0);
    await cpu.writeUint32(0x4005009c,9);
    await cpu.writeUint32(0x40050090,16);
    for(let i=0; i < 1000; i++) { cpu.singleStep(); }
  });
});
