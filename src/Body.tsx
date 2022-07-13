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
import {
    AccountMeta,
    Connection,
    LAMPORTS_PER_SOL,
    PublicKey,
    SystemProgram,
    TransactionInstruction,
} from '@solana/web3.js';
import { Provider, Program } from '@project-serum/anchor';
import { SmartInstructionSender } from '@holaplex/solana-web3-tools';
import { withdrawInstructions } from './instructions';
import { COMMITMENT, DEFAULT_RPC_URI, LAUNCH_PROGRAM_ID_V1, LAUNCH_PROGRAM_ID_V2, RPC_TIMEOUT } from './constants';
import { V1_ACCOUNTS, V0_DETAILS } from './known-accounts';
import { useSmartSender } from './hooks';
import { NftSale, IDL } from './idl';
import type { MasterAccount, InnerV0Details } from './types';

const Body = () => {
    const wallet = useAnchorWallet() as AnchorWallet;
    const { enqueueSnackbar } = useSnackbar();
    const [balance, setBalance] = useState<number | null>(null);
    const [anchorProgram, setAnchorProgram] = useState<Program<NftSale> | null>(null);
    const [masterAccountKey, setMasterAccountKey] = useState<PublicKey | null>(null);
    const [authorityAccountKey, setAuthorityAccountKey] = useState<PublicKey | null>(null);
    const [v0Details, setV0Details] = useState<InnerV0Details | null>(null);
    const [masterAccountObj, setMasterAccountObj] = useState<MasterAccount | null>(null);
    const [loading, setLoading] = useState<boolean>(false);
    const [withdrawing, setWithdrawing] = useState<boolean>(false);
    const [txId, setTxId] = useState<string | null>(null);
    const urlParams = queryString.parse(window.location.search);
    const { failureCallback } = useSmartSender();

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

        if (Object.keys(V0_DETAILS).includes(formik.values.masterAccount)) {
            const thisV0Details = V0_DETAILS[formik.values.masterAccount];
            if (thisV0Details) {
                const thisAuthorityAccountKey = new PublicKey(formik.values.masterAccount);
                setAuthorityAccountKey(thisAuthorityAccountKey);
                const programKey = new PublicKey(thisV0Details.programAddress);
                const [programAuthority, _nonce] = await PublicKey.findProgramAddress([thisV0Details.seed], programKey);
                thisV0Details.programAuthority = programAuthority;
                setV0Details(thisV0Details);
                const solBalance = await connection.getBalance(programAuthority);
                if (solBalance > 0) {
                    setBalance(solBalance / LAMPORTS_PER_SOL);
                } else {
                    setBalance(0);
                }
            }
        } else {
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
                    .onFailure(failureCallback)
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
    }, [
        wallet,
        balance,
        failureCallback,
        enqueueSnackbar,
        masterAccountKey,
        masterAccountObj,
        anchorProgram,
        loadEverything,
    ]);
    // end run withdrawal

    // run withdrawal for v0 programs
    const withdrawV0 = useCallback(async () => {
        setTxId(null);
        setWithdrawing(true);
        try {
            if (wallet && authorityAccountKey && v0Details && v0Details.programAuthority) {
                const connection = new Connection(formik.values.rpc, {
                    commitment: COMMITMENT,
                    confirmTransactionInitialTimeout: RPC_TIMEOUT,
                });

                const programId = new PublicKey(v0Details.programAddress);

                const keys: AccountMeta[] = [
                    // caller
                    { pubkey: wallet.publicKey, isSigner: true, isWritable: false },
                    // authority
                    { pubkey: authorityAccountKey, isSigner: false, isWritable: true },
                ];

                for (let index = 0; index < v0Details.recipients.length; index++) {
                    const element = v0Details.recipients[index];
                    if (element) {
                        keys.push({ pubkey: new PublicKey(element), isSigner: false, isWritable: true });
                    }
                }

                keys.push(
                    // program authority
                    { pubkey: v0Details.programAuthority, isSigner: false, isWritable: true }
                );
                keys.push(
                    // Solana system program
                    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
                );

                const pdaResult = await PublicKey.findProgramAddress([v0Details.seed], programId);
                const dataArray = v0Details.data.concat([pdaResult[1]]);

                const instruction = new TransactionInstruction({
                    keys,
                    programId,
                    data: Buffer.from(Uint8Array.from(dataArray)),
                });

                const sender = SmartInstructionSender.build(wallet, connection)
                    .config({
                        maxSigningAttempts: 3,
                        abortOnFailure: true,
                        commitment: COMMITMENT,
                    })
                    .withInstructionSets([
                        {
                            instructions: [instruction],
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
                    .onFailure(failureCallback)
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
    }, [
        wallet,
        balance,
        enqueueSnackbar,
        failureCallback,
        formik.values.rpc,
        authorityAccountKey,
        v0Details,
        loadEverything,
    ]);
    // end run withdrawal for v0 programs

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
                        <React.Fragment>
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
                                                {withdrawing === true ? 'Withdrawing' : 'Click To Withdraw'} {balance}{' '}
                                                SOL
                                            </Button>
                                        </Box>
                                    )}
                                </React.Fragment>
                            )}
                            {authorityAccountKey && v0Details && v0Details.programAuthority && (
                                <React.Fragment>
                                    <Box
                                        sx={{
                                            mt: 5,
                                        }}
                                    >
                                        <Typography variant="h6" component="div" sx={{ flexGrow: 1 }}>
                                            Smart Contract Details
                                        </Typography>
                                        <TableContainer component={Paper}>
                                            <Table sx={{ minWidth: 650 }} aria-label="Master Account Details">
                                                <TableBody>
                                                    <TableRow>
                                                        <TableCell component="th" scope="row">
                                                            Program Authority
                                                        </TableCell>
                                                        <TableCell align="right">
                                                            {v0Details.programAuthority.toBase58()}
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
                                                onClick={withdrawV0}
                                                color="success"
                                                variant="contained"
                                                fullWidth
                                                type="submit"
                                            >
                                                {withdrawing === true ? 'Withdrawing' : 'Click To Withdraw'} {balance}{' '}
                                                SOL
                                            </Button>
                                        </Box>
                                    )}
                                </React.Fragment>
                            )}
                        </React.Fragment>
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
