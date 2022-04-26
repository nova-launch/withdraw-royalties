export type NftSale = {
    version: '0.3.0';
    name: 'nft_sale';
    instructions: [
        {
            name: 'withdraw';
            accounts: [
                {
                    name: 'caller';
                    isMut: false;
                    isSigner: true;
                },
                {
                    name: 'masterAccount';
                    isMut: false;
                    isSigner: false;
                },
                {
                    name: 'programAuthority';
                    isMut: true;
                    isSigner: false;
                },
                {
                    name: 'systemProgram';
                    isMut: false;
                    isSigner: false;
                }
            ];
            args: [];
            returns: null;
        }
    ];
    accounts: [
        {
            name: 'masterAccount';
            type: {
                kind: 'struct';
                fields: [
                    {
                        name: 'authority';
                        type: 'publicKey';
                    },
                    {
                        name: 'developer';
                        type: 'publicKey';
                    },
                    {
                        name: 'programAuthority';
                        type: 'publicKey';
                    },
                    {
                        name: 'bump';
                        type: 'u8';
                    },
                    {
                        name: 'revenueShare';
                        type: {
                            vec: {
                                defined: 'Share';
                            };
                        };
                    },
                    {
                        name: 'royaltyShare';
                        type: {
                            vec: {
                                defined: 'Share';
                            };
                        };
                    },
                    {
                        name: 'padding0';
                        type: 'u128';
                    },
                    {
                        name: 'padding1';
                        type: 'u128';
                    },
                    {
                        name: 'padding2';
                        type: 'u128';
                    },
                    {
                        name: 'padding3';
                        type: 'u128';
                    },
                    {
                        name: 'padding4';
                        type: 'u128';
                    }
                ];
            };
        }
    ];
    types: [];
    errors: [
        {
            code: 6007;
            name: 'NumericalOverflowError';
            msg: 'Numerical overflow error!';
        }
    ];
};

export const IDL: NftSale = {
    version: '0.3.0',
    name: 'nft_sale',
    instructions: [
        {
            name: 'withdraw',
            accounts: [
                {
                    name: 'caller',
                    isMut: false,
                    isSigner: true,
                },
                {
                    name: 'masterAccount',
                    isMut: false,
                    isSigner: false,
                },
                {
                    name: 'programAuthority',
                    isMut: true,
                    isSigner: false,
                },
                {
                    name: 'systemProgram',
                    isMut: false,
                    isSigner: false,
                },
            ],
            args: [],
            returns: null,
        },
    ],
    accounts: [
        {
            name: 'masterAccount',
            type: {
                kind: 'struct',
                fields: [
                    {
                        name: 'authority',
                        type: 'publicKey',
                    },
                    {
                        name: 'developer',
                        type: 'publicKey',
                    },
                    {
                        name: 'programAuthority',
                        type: 'publicKey',
                    },
                    {
                        name: 'bump',
                        type: 'u8',
                    },
                    {
                        name: 'revenueShare',
                        type: {
                            vec: {
                                defined: 'Share',
                            },
                        },
                    },
                    {
                        name: 'royaltyShare',
                        type: {
                            vec: {
                                defined: 'Share',
                            },
                        },
                    },
                    {
                        name: 'padding0',
                        type: 'u128',
                    },
                    {
                        name: 'padding1',
                        type: 'u128',
                    },
                    {
                        name: 'padding2',
                        type: 'u128',
                    },
                    {
                        name: 'padding3',
                        type: 'u128',
                    },
                    {
                        name: 'padding4',
                        type: 'u128',
                    },
                ],
            },
        },
    ],
    types: [],
    errors: [
        {
            code: 6007,
            name: 'NumericalOverflowError',
            msg: 'Numerical overflow error!',
        },
    ],
};
