import { WalletError } from '@solana/wallet-adapter-base';
import { WalletDialogProvider, WalletMultiButton } from '@solana/wallet-adapter-material-ui';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import {
    GlowWalletAdapter,
    PhantomWalletAdapter,
    SlopeWalletAdapter,
    SolletWalletAdapter,
} from '@solana/wallet-adapter-wallets';
import { useSnackbar } from 'notistack';
import { DEFAULT_RPC_URI } from './constants';
import React, { FC, ReactNode, useCallback, useMemo } from 'react';
import { Theme } from './Theme';

export const App: FC = () => {
    const rpcUri = DEFAULT_RPC_URI;
    return (
        <Theme>
            <Context rpcUri={rpcUri}>
                <Content />
            </Context>
        </Theme>
    );
};

interface ContextProps {
    children: ReactNode;
    rpcUri: string;
}

const Context: FC<ContextProps> = ({ children, rpcUri }) => {
    const endpoint = useMemo(() => rpcUri, [rpcUri]);

    // @solana/wallet-adapter-wallets includes all the adapters but supports tree shaking and lazy loading --
    // Only the wallets you configure here will be compiled into your application, and only the dependencies
    // of wallets that your users connect to will be loaded.
    const wallets = useMemo(
        () => [
            new PhantomWalletAdapter(),
            new GlowWalletAdapter(),
            new SlopeWalletAdapter(),
            new SolletWalletAdapter(),
        ],
        []
    );

    const { enqueueSnackbar } = useSnackbar();
    const onError = useCallback(
        (error: WalletError) => {
            enqueueSnackbar(error.message ? `${error.name}: ${error.message}` : error.name, { variant: 'error' });
            console.error(error);
        },
        [enqueueSnackbar]
    );

    return (
        <ConnectionProvider endpoint={endpoint}>
            <WalletProvider wallets={wallets} onError={onError} autoConnect>
                <WalletDialogProvider>{children}</WalletDialogProvider>
            </WalletProvider>
        </ConnectionProvider>
    );
};

const Content: FC = () => {
    return <WalletMultiButton />;
};
