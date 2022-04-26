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
import { useFormik } from 'formik';
import * as yup from 'yup';
import { Connection, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { BN, Provider, Program } from '@project-serum/anchor';
import { COMMITMENT, DEFAULT_RPC_URI, LAUNCH_PROGRAM_ID_V1, RPC_TIMEOUT } from './constants';
import { NftSale, IDL } from './idl';
import type { MasterAccount } from './types';

const Body = () => {
    const wallet = useAnchorWallet() as AnchorWallet;
    const [balance, setBalance] = useState<number | null>(null);
    const [anchorProgram, setAnchorProgram] = useState<Program<NftSale> | null>(null);
    const [masterAccountObj, setMasterAccountObj] = useState<MasterAccount | null>(null);
    const [loading, setLoading] = useState<boolean>(false);

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
            masterAccount: '',
        },
        validationSchema: validationSchema,
        onSubmit: (values) => {
            setLoading(true);
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
        const program = new Program(
            IDL,
            LAUNCH_PROGRAM_ID_V1,
            new Provider(connection, wallet, Provider.defaultOptions())
        );

        if (wallet && program) {
            setAnchorProgram(program);
            const masterAccount = await program.account.masterAccount.fetchNullable(formik.values.masterAccount);
            if (masterAccount) {
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
                                        <Button color="success" variant="contained" fullWidth type="submit">
                                            Click To Withdraw {balance} SOL
                                        </Button>
                                    </Box>
                                )}
                            </React.Fragment>
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
                                    value={formik.values.rpc}
                                    onChange={formik.handleChange}
                                    error={formik.touched.rpc && Boolean(formik.errors.rpc)}
                                    helperText={formik.touched.rpc && formik.errors.rpc}
                                />
                                {wallet ? (
                                    <Button
                                        disabled={loading}
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
