import type { AnchorTypes } from '@saberhq/anchor-contrib';
import { IDL } from './idl';

export type ProgramTypes = AnchorTypes<typeof IDL>;
type Accounts = ProgramTypes['Accounts'];

export type MasterAccount = Accounts['masterAccount'];
