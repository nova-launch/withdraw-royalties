import type { AnchorTypes } from '@saberhq/anchor-contrib';
import { PublicKey } from '@solana/web3.js';
import { IDL } from './idl';

export type ProgramTypes = AnchorTypes<typeof IDL>;
type Accounts = ProgramTypes['Accounts'];

export type MasterAccount = Accounts['masterAccount'];

export interface InnerV0Details {
    programAddress: string;
    programAuthority?: PublicKey;
    recipients: string[];
    seed: Buffer;
    data: number[];
}

export interface V0Details {
    [key: string]: InnerV0Details;
}
