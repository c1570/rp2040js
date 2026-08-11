import { IRPChip } from '../rpchip';

export interface IGDBTarget<ChipType extends IRPChip = IRPChip> {
  readonly executing: boolean;
  rpchip: ChipType;

  execute(): void;
  stop(): void;
}
