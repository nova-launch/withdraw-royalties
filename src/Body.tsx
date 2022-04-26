import React, { useCallback, useState } from 'react';
import { WalletMultiButton } from '@solana/wallet-adapter-material-ui';
import { useAnchorWallet, AnchorWallet } from '@solana/wallet-adapter-react';
import {
    AppBar,
    Box,
    Button,
    Container,
    Grid,
    Paper,
    Table,
    TableBody,
    TableCell,
    TableContainer,
    TableRow,
    TextField,
    Toolbar,
    Typography,
} from '@mui/material';
import queryString from 'query-string';
import { useFormik } from 'formik';
import * as yup from 'yup';
import { useSnackbar } from 'notistack';
import { Connection, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { Provider, Program } from '@project-serum/anchor';
import { SmartInstructionSender } from '@holaplex/solana-web3-tools';
import { withdrawInstructions } from './instructions';
import { COMMITMENT, DEFAULT_RPC_URI, LAUNCH_PROGRAM_ID_V1, LAUNCH_PROGRAM_ID_V2, RPC_TIMEOUT } from './constants';
import { V1_ACCOUNTS } from './known-accounts';
import { NftSale, IDL } from './idl';
import type { MasterAccount } from './types';

const Body = () => {
    const wallet = useAnchorWallet() as AnchorWallet;
    const { enqueueSnackbar } = useSnackbar();
    const [balance, setBalance] = useState<number | null>(null);
    const [anchorProgram, setAnchorProgram] = useState<Program<NftSale> | null>(null);
    const [masterAccountKey, setMasterAccountKey] = useState<PublicKey | null>(null);
    const [masterAccountObj, setMasterAccountObj] = useState<MasterAccount | null>(null);
    const [loading, setLoading] = useState<boolean>(false);
    const [withdrawing, setWithdrawing] = useState<boolean>(false);
    const [txId, setTxId] = useState<string | null>(null);
    const urlParams = queryString.parse(window.location.search);

    // formik stuff
    const validatePubkey = (value: string | undefined) => {
        if (value) {
            try {
                new PublicKey(value);
                return true;
            } catch {
                return false;
            }
        }
        return true;
    };
    const validationSchema = yup.object({
        rpc: yup.string().url('Enter a valid RPC URI (must include https)').required('RPC is required'),
        masterAccount: yup
            .string()
            .test('isPubkey', 'This value must be a Solana address', validatePubkey)
            .required('Master Account is required'),
    });
    const formik = useFormik({
        initialValues: {
            rpc: DEFAULT_RPC_URI,
            masterAccount: urlParams.account == null ? '' : urlParams.account.toString(),
        },
        validationSchema: validationSchema,
        onSubmit: (values) => {
            setLoading(true);
            setTxId(null);
            loadEverything();
            console.log(JSON.stringify(values, null, 2));
        },
    });
    // end formik stuff

    // load master account
    const loadEverything = useCallback(async () => {
        const connection = new Connection(formik.values.rpc, {
            commitment: COMMITMENT,
            confirmTransactionInitialTimeout: RPC_TIMEOUT,
        });

        let programId = LAUNCH_PROGRAM_ID_V2;
        if (V1_ACCOUNTS.includes(formik.values.masterAccount)) {
            programId = LAUNCH_PROGRAM_ID_V1;
        }
        const program = new Program(IDL, programId, new Provider(connection, wallet, Provider.defaultOptions()));

        if (wallet && program) {
            setAnchorProgram(program);
            const thisMasterAccountKey = new PublicKey(formik.values.masterAccount);
            const masterAccount = await program.account.masterAccount.fetchNullable(thisMasterAccountKey);
            if (masterAccount) {
                setMasterAccountKey(thisMasterAccountKey);
                setMasterAccountObj(masterAccount as MasterAccount);
                const solBalance = await program.provider.connection.getBalance(masterAccount.programAuthority);
                if (solBalance > 0) {
                    setBalance(solBalance / LAMPORTS_PER_SOL);
                } else {
                    setBalance(0);
                }
            }
        }
        setLoading(false);
    }, [wallet, formik.values]);
    // end load master account

    // run withdrawal
    const withdraw = useCallback(async () => {
        setTxId(null);
        setWithdrawing(true);
        try {
            if (wallet && masterAccountKey && masterAccountObj && anchorProgram) {
                const { instructions } = await withdrawInstructions({
                    payer: wallet.publicKey,
                    masterAccountKey,
                    masterAccountObj,
                    program: anchorProgram,
                });
                const sender = SmartInstructionSender.build(wallet, anchorProgram.provider.connection)
                    .config({
                        maxSigningAttempts: 3,
                        abortOnFailure: true,
                        commitment: COMMITMENT,
                    })
                    .withInstructionSets([
                        {
                            instructions,
                            signers: [],
                        },
                    ])
                    .onProgress((_currentIndex, txId) => {
                        setTxId(txId);
                        const balMsg = balance == null ? '' : `${balance} SOL`;
                        const msg = `Successfully withdrew ${balMsg}`;
                        enqueueSnackbar(msg, { variant: 'success' });
                        console.log(`Just sent: ${txId}`);
                    })
                    .onFailure((err: Error) => {
                        enqueueSnackbar(err.toString(), { variant: 'error' });
                        console.log(`Error: ${err}`);
                    })
                    .onReSign((attempt, i) => {
                        const msg = `ReSigning: ${i} attempt: ${attempt}`;
                        enqueueSnackbar(msg, { variant: 'warning' });
                        console.warn(msg);
                    });
                enqueueSnackbar('Sending withdrawal request', { variant: 'info' });
                sender
                    .send()
                    .then(() => loadEverything())
                    .finally(() => setWithdrawing(false));
            } else {
                console.log('Master Account not loaded properly!');
                setWithdrawing(false);
            }
        } catch (err: any) {
            enqueueSnackbar(err.toString(), { variant: 'error' });
            console.log(`Error: ${err}`);
        }
    }, [wallet, balance, enqueueSnackbar, masterAccountKey, masterAccountObj, anchorProgram, loadEverything]);
    // end run withdrawal

    return (
        <Container fixed>
            <AppBar position="static">
                <Toolbar>
                    <Typography variant="h5" component="div" sx={{ flexGrow: 1 }}>
                        Withdraw Royalties
                    </Typography>
                    <WalletMultiButton />
                </Toolbar>
            </AppBar>
            <Grid container spacing={2} direction="row" justifyContent="center" alignItems="center">
                <Grid item xs={12}>
                    <Box
                        sx={{
                            bgcolor: 'background.paper',
                            p: 3,
                        }}
                    >
                        <Typography component="p">Use this tool to withdraw your royalties.</Typography>
                        {masterAccountObj && (
                            <React.Fragment>
                                <Box
                                    sx={{
                                        mt: 5,
                                    }}
                                >
                                    <Typography variant="h6" component="div" sx={{ flexGrow: 1 }}>
                                        Master Account Details
                                    </Typography>
                                    <TableContainer component={Paper}>
                                        <Table sx={{ minWidth: 650 }} aria-label="Master Account Details">
                                            <TableBody>
                                                <TableRow>
                                                    <TableCell component="th" scope="row">
                                                        Program Authority
                                                    </TableCell>
                                                    <TableCell align="right">
                                                        {masterAccountObj.programAuthority.toBase58()}
                                                    </TableCell>
                                                </TableRow>
                                                {balance != null && (
                                                    <TableRow>
                                                        <TableCell component="th" scope="row">
                                                            Royalty Balance
                                                        </TableCell>
                                                        <TableCell align="right">{balance} SOL</TableCell>
                                                    </TableRow>
                                                )}
                                            </TableBody>
                                        </Table>
                                    </TableContainer>
                                </Box>
                                {balance != null && (
                                    <Box
                                        sx={{
                                            mt: 1,
                                        }}
                                    >
                                        <Button
                                            disabled={withdrawing}
                                            onClick={withdraw}
                                            color="success"
                                            variant="contained"
                                            fullWidth
                                            type="submit"
                                        >
                                            {withdrawing === true ? 'Withdrawing' : 'Click To Withdraw'} {balance} SOL
                                        </Button>
                                    </Box>
                                )}
                            </React.Fragment>
                        )}
                        {txId && (
                            <Box
                                sx={{
                                    mt: 1,
                                }}
                            >
                                <Typography component="p">
                                    <a
                                        id="nova-mint-transaction-link"
                                        href={`https://explorer.solana.com/tx/${txId}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                    >
                                        View transaction on Solana Explorer
                                    </a>
                                </Typography>
                            </Box>
                        )}
                        <Box
                            sx={{
                                mt: 5,
                            }}
                        >
                            <form onSubmit={formik.handleSubmit}>
                                <TextField
                                    fullWidth
                                    id="masterAccount"
                                    name="masterAccount"
                                    label="Master Account"
                                    disabled={loading || withdrawing}
                                    value={formik.values.masterAccount}
                                    onChange={formik.handleChange}
                                    error={formik.touched.masterAccount && Boolean(formik.errors.masterAccount)}
                                    helperText={formik.touched.masterAccount && formik.errors.masterAccount}
                                />
                                <TextField
                                    fullWidth
                                    id="rpc"
                                    name="rpc"
                                    label="RPC"
                                    disabled={loading || withdrawing}
                                    value={formik.values.rpc}
                                    onChange={formik.handleChange}
                                    error={formik.touched.rpc && Boolean(formik.errors.rpc)}
                                    helperText={formik.touched.rpc && formik.errors.rpc}
                                />
                                {wallet ? (
                                    <Button
                                        disabled={loading || withdrawing}
                                        color="primary"
                                        variant="contained"
                                        fullWidth
                                        type="submit"
                                    >
                                        {loading === true ? 'Loading' : 'Load'} Master Account
                                    </Button>
                                ) : (
                                    <Box
                                        sx={{
                                            mt: 5,
                                        }}
                                    >
                                        <WalletMultiButton />
                                    </Box>
                                )}
                            </form>
                        </Box>
                    </Box>
                </Grid>
            </Grid>
        </Container>
    );
};

export default Body;
