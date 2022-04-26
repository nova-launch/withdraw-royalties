import { web3, Program } from '@project-serum/anchor';
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, Token } from '@solana/spl-token';
import type { NftSale } from './idl';

export interface ShareObj {
    address: web3.PublicKey;
    share: number;
}

export interface RemainingAccount {
    pubkey: web3.PublicKey;
    isWritable: boolean;
    isSigner: boolean;
}

export interface WithdrawParams {
    payer: web3.PublicKey;
    masterAccount: web3.PublicKey;
    mint?: web3.PublicKey;
    program: Program<NftSale>;
}

/**
 * Get associated token address
 *
 * @param owner - the public key that owns the associated token address
 * @param mint - the mint
 * @returns a promise of the associated token address
 */
export async function getAssociatedTokenAddress(owner: web3.PublicKey, mint: web3.PublicKey): Promise<web3.PublicKey> {
    const [address] = await web3.PublicKey.findProgramAddress(
        [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
        ASSOCIATED_TOKEN_PROGRAM_ID
    );
    return address;
}

export const withdrawInstructions = async (params: WithdrawParams) => {
    const { payer, masterAccount, mint, program } = params;

    const masterAccountObj = await program.account.masterAccount.fetch(masterAccount);
    const royaltyShareObjects = masterAccountObj.royaltyShare as ShareObj[];
    const instructions = [];
    const remainingAccounts = [];
    if (mint != null) {
        const tokenAccount = await getAssociatedTokenAddress(masterAccountObj.programAuthority, mint);
        const tokenAccountInfo = await program.provider.connection.getParsedAccountInfo(tokenAccount);
        if (tokenAccountInfo.value === null) {
            instructions.push(
                Token.createAssociatedTokenAccountInstruction(
                    ASSOCIATED_TOKEN_PROGRAM_ID,
                    TOKEN_PROGRAM_ID,
                    mint,
                    tokenAccount,
                    masterAccountObj.programAuthority, // owner
                    payer // pays for transaction
                )
            );
        }
        remainingAccounts.push({ pubkey: mint, isWritable: false, isSigner: false });
        remainingAccounts.push({ pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false });
        remainingAccounts.push({ pubkey: tokenAccount, isWritable: true, isSigner: false });
        for (let index = 0; index < royaltyShareObjects.length; index++) {
            const shareRecipient = royaltyShareObjects[index];
            const shareRecipientTokenAccount = await getAssociatedTokenAddress(shareRecipient.address, mint);
            remainingAccounts.push({ pubkey: shareRecipientTokenAccount, isWritable: true, isSigner: false });
        }
    } else {
        for (let index = 0; index < royaltyShareObjects.length; index++) {
            const shareRecipient = royaltyShareObjects[index];
            remainingAccounts.push({ pubkey: shareRecipient.address, isWritable: true, isSigner: false });
        }
    }

    instructions.push(
        program.instruction.withdraw({
            accounts: {
                caller: payer,
                masterAccount: masterAccount,
                programAuthority: masterAccountObj.programAuthority,
                systemProgram: web3.SystemProgram.programId,
            },
            remainingAccounts,
        })
    );

    return { instructions };
};
