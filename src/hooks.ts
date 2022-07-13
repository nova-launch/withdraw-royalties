import { useState } from 'react';
import { SendAndConfirmError } from '@holaplex/solana-web3-tools';
import { useSnackbar } from 'notistack';

export const useSmartSender = () => {
    const { enqueueSnackbar } = useSnackbar();
    const [doneItems, setDoneItems] = useState<[number, string][]>([]);

    const progressCallback = (currentIndex: number, txId: string, func = setDoneItems) => {
        func((prevState) => prevState.concat([[currentIndex, txId]]));
        console.log('Sent', txId);
    };

    const failureCallback = (errorObj: SendAndConfirmError) => {
        console.log('Error type', errorObj.type);
        let errorMsg: string | null = null;

        if (errorObj.type == 'tx-error') {
            if (typeof errorObj.inner !== 'string') {
                try {
                    const errorCode = (errorObj.inner as any).InstructionError[1].Custom;
                    if (errorCode) {
                        errorMsg = `Error Code: ${errorCode}`;
                    }
                } catch (newErr: any) {
                    console.log('New error:', newErr);
                }
            } else {
                errorMsg = errorObj.inner;
            }
        }

        if (!errorMsg) {
            errorMsg = errorObj.type;
        }

        if (errorObj.txid) {
            console.log('Error txId', errorObj.txid);
        }

        if (errorMsg) {
            enqueueSnackbar(errorMsg, { variant: 'error' });
            throw new Error(errorMsg);
        } else {
            console.log('Unknown error', errorObj);
            throw new Error(errorObj.toString());
        }
    };

    return {
        doneItems,
        setDoneItems,
        failureCallback,
        progressCallback,
    };
};
