import { SimulationClock } from './simulation-clock';

export class MockClock extends SimulationClock {
  advance(deltaMicros: number) {
    this.tick(this.nanos + deltaMicros * 1000);
  }
}
