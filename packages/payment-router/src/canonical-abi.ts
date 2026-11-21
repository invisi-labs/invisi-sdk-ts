// Public ABI snapshots from invisi-periphery ffd81f4; no implementation bytecode.
export const paymentRouterAbi = [
    {
        "type": "constructor",
        "inputs": [
            {
                "name": "core_",
                "type": "address",
                "internalType": "address",
            },
            {
                "name": "dex_",
                "type": "address",
                "internalType": "address",
            },
            {
                "name": "weth_",
                "type": "address",
                "internalType": "address",
            },
            {
                "name": "holder_",
                "type": "address",
                "internalType": "address",
            },
            {
                "name": "registry_",
                "type": "address",
                "internalType": "address",
            },
        ],
        "stateMutability": "nonpayable",
    },
    {
        "type": "receive",
        "stateMutability": "payable",
    },
    {
        "type": "function",
        "name": "CHAIN_ID",
        "inputs": [],
        "outputs": [
            {
                "name": "",
                "type": "uint256",
                "internalType": "uint256",
            },
        ],
        "stateMutability": "view",
    },
    {
        "type": "function",
        "name": "INTENT_TYPEHASH",
        "inputs": [],
        "outputs": [
            {
                "name": "",
                "type": "bytes32",
                "internalType": "bytes32",
            },
        ],
        "stateMutability": "view",
    },
    {
        "type": "function",
        "name": "allowanceHolder",
        "inputs": [],
        "outputs": [
            {
                "name": "",
                "type": "address",
                "internalType": "address",
            },
        ],
        "stateMutability": "view",
    },
    {
        "type": "function",
        "name": "core",
        "inputs": [],
        "outputs": [
            {
                "name": "",
                "type": "address",
                "internalType": "contract IInvisiCore",
            },
        ],
        "stateMutability": "view",
    },
    {
        "type": "function",
        "name": "dex",
        "inputs": [],
        "outputs": [
            {
                "name": "",
                "type": "address",
                "internalType": "contract IUniswapV3SwapRouter",
            },
        ],
        "stateMutability": "view",
    },
    {
        "type": "function",
        "name": "eip712Domain",
        "inputs": [],
        "outputs": [
            {
                "name": "fields",
                "type": "bytes1",
                "internalType": "bytes1",
            },
            {
                "name": "name",
                "type": "string",
                "internalType": "string",
            },
            {
                "name": "version",
                "type": "string",
                "internalType": "string",
            },
            {
                "name": "chainId",
                "type": "uint256",
                "internalType": "uint256",
            },
            {
                "name": "verifyingContract",
                "type": "address",
                "internalType": "address",
            },
            {
                "name": "salt",
                "type": "bytes32",
                "internalType": "bytes32",
            },
            {
                "name": "extensions",
                "type": "uint256[]",
                "internalType": "uint256[]",
            },
        ],
        "stateMutability": "view",
    },
    {
        "type": "function",
        "name": "hashIntent",
        "inputs": [
            {
                "name": "i",
                "type": "tuple",
                "internalType": "struct IPaymentRouter.Intent",
                "components": [
                    {
                        "name": "payer",
                        "type": "address",
                        "internalType": "address",
                    },
                    {
                        "name": "tokenIn",
                        "type": "address",
                        "internalType": "address",
                    },
                    {
                        "name": "amountInMaximum",
                        "type": "uint256",
                        "internalType": "uint256",
                    },
                    {
                        "name": "refundRecipient",
                        "type": "address",
                        "internalType": "address",
                    },
                    {
                        "name": "relayer",
                        "type": "address",
                        "internalType": "address",
                    },
                    {
                        "name": "nonce",
                        "type": "uint256",
                        "internalType": "uint256",
                    },
                    {
                        "name": "deadline",
                        "type": "uint256",
                        "internalType": "uint256",
                    },
                    {
                        "name": "coreRequestHash",
                        "type": "bytes32",
                        "internalType": "bytes32",
                    },
                    {
                        "name": "routeHash",
                        "type": "bytes32",
                        "internalType": "bytes32",
                    },
                    {
                        "name": "mode",
                        "type": "uint8",
                        "internalType": "enum IPaymentRouter.Mode",
                    },
                ],
            },
        ],
        "outputs": [
            {
                "name": "",
                "type": "bytes32",
                "internalType": "bytes32",
            },
        ],
        "stateMutability": "view",
    },
    {
        "type": "function",
        "name": "invalidateNonces",
        "inputs": [
            {
                "name": "newNonce",
                "type": "uint256",
                "internalType": "uint256",
            },
        ],
        "outputs": [],
        "stateMutability": "nonpayable",
    },
    {
        "type": "function",
        "name": "nonces",
        "inputs": [
            {
                "name": "",
                "type": "address",
                "internalType": "address",
            },
        ],
        "outputs": [
            {
                "name": "",
                "type": "uint256",
                "internalType": "uint256",
            },
        ],
        "stateMutability": "view",
    },
    {
        "type": "function",
        "name": "payNative",
        "inputs": [
            {
                "name": "proof",
                "type": "bytes",
                "internalType": "bytes",
            },
            {
                "name": "r",
                "type": "tuple",
                "internalType": "struct IInvisiCore.TransactRequest",
                "components": [
                    {
                        "name": "params",
                        "type": "tuple",
                        "internalType": "struct IInvisiCore.CrossTreeTransactParams",
                        "components": [
                            {
                                "name": "token",
                                "type": "address",
                                "internalType": "address",
                            },
                            {
                                "name": "sources",
                                "type": "tuple[]",
                                "internalType": "struct IInvisiCore.InputSource[]",
                                "components": [
                                    {
                                        "name": "treeId",
                                        "type": "uint256",
                                        "internalType": "uint256",
                                    },
                                    {
                                        "name": "merkleRoot",
                                        "type": "bytes32",
                                        "internalType": "bytes32",
                                    },
                                ],
                            },
                            {
                                "name": "nullifiers",
                                "type": "bytes32[]",
                                "internalType": "bytes32[]",
                            },
                            {
                                "name": "noteCommitments",
                                "type": "bytes32[]",
                                "internalType": "bytes32[]",
                            },
                            {
                                "name": "withdrawalAddress",
                                "type": "address",
                                "internalType": "address",
                            },
                            {
                                "name": "withdrawalAmount",
                                "type": "uint256",
                                "internalType": "uint256",
                            },
                            {
                                "name": "deadline",
                                "type": "uint256",
                                "internalType": "uint256",
                            },
                            {
                                "name": "feeRecipient",
                                "type": "address",
                                "internalType": "address",
                            },
                            {
                                "name": "feeAmount",
                                "type": "uint256",
                                "internalType": "uint256",
                            },
                        ],
                    },
                    {
                        "name": "deliveries",
                        "type": "tuple[]",
                        "internalType": "struct IInvisiCore.Delivery[]",
                        "components": [
                            {
                                "name": "ciphertext",
                                "type": "bytes",
                                "internalType": "bytes",
                            },
                            {
                                "name": "clue",
                                "type": "bytes",
                                "internalType": "bytes",
                            },
                        ],
                    },
                    {
                        "name": "funding",
                        "type": "tuple",
                        "internalType": "struct IInvisiCore.FundingParams",
                        "components": [
                            {
                                "name": "payer",
                                "type": "address",
                                "internalType": "address",
                            },
                            {
                                "name": "amount",
                                "type": "uint256",
                                "internalType": "uint256",
                            },
                            {
                                "name": "sigNonce",
                                "type": "uint256",
                                "internalType": "uint256",
                            },
                            {
                                "name": "deadline",
                                "type": "uint256",
                                "internalType": "uint256",
                            },
                            {
                                "name": "signature",
                                "type": "bytes",
                                "internalType": "bytes",
                            },
                            {
                                "name": "permit",
                                "type": "tuple",
                                "internalType": "struct IMetaTx.TokenPermit",
                                "components": [
                                    {
                                        "name": "deadline",
                                        "type": "uint256",
                                        "internalType": "uint256",
                                    },
                                    {
                                        "name": "v",
                                        "type": "uint8",
                                        "internalType": "uint8",
                                    },
                                    {
                                        "name": "r",
                                        "type": "bytes32",
                                        "internalType": "bytes32",
                                    },
                                    {
                                        "name": "s",
                                        "type": "bytes32",
                                        "internalType": "bytes32",
                                    },
                                ],
                            },
                        ],
                    },
                ],
            },
            {
                "name": "i",
                "type": "tuple",
                "internalType": "struct IPaymentRouter.Intent",
                "components": [
                    {
                        "name": "payer",
                        "type": "address",
                        "internalType": "address",
                    },
                    {
                        "name": "tokenIn",
                        "type": "address",
                        "internalType": "address",
                    },
                    {
                        "name": "amountInMaximum",
                        "type": "uint256",
                        "internalType": "uint256",
                    },
                    {
                        "name": "refundRecipient",
                        "type": "address",
                        "internalType": "address",
                    },
                    {
                        "name": "relayer",
                        "type": "address",
                        "internalType": "address",
                    },
                    {
                        "name": "nonce",
                        "type": "uint256",
                        "internalType": "uint256",
                    },
                    {
                        "name": "deadline",
                        "type": "uint256",
                        "internalType": "uint256",
                    },
                    {
                        "name": "coreRequestHash",
                        "type": "bytes32",
                        "internalType": "bytes32",
                    },
                    {
                        "name": "routeHash",
                        "type": "bytes32",
                        "internalType": "bytes32",
                    },
                    {
                        "name": "mode",
                        "type": "uint8",
                        "internalType": "enum IPaymentRouter.Mode",
                    },
                ],
            },
            {
                "name": "route",
                "type": "tuple",
                "internalType": "struct IPaymentRouter.Route",
                "components": [
                    {
                        "name": "channel",
                        "type": "uint8",
                        "internalType": "enum IPaymentRouter.Channel",
                    },
                    {
                        "name": "path",
                        "type": "bytes",
                        "internalType": "bytes",
                    },
                    {
                        "name": "target",
                        "type": "address",
                        "internalType": "address",
                    },
                    {
                        "name": "data",
                        "type": "bytes",
                        "internalType": "bytes",
                    },
                ],
            },
        ],
        "outputs": [
            {
                "name": "spent",
                "type": "uint256",
                "internalType": "uint256",
            },
        ],
        "stateMutability": "payable",
    },
    {
        "type": "function",
        "name": "payToken",
        "inputs": [
            {
                "name": "proof",
                "type": "bytes",
                "internalType": "bytes",
            },
            {
                "name": "r",
                "type": "tuple",
                "internalType": "struct IInvisiCore.TransactRequest",
                "components": [
                    {
                        "name": "params",
                        "type": "tuple",
                        "internalType": "struct IInvisiCore.CrossTreeTransactParams",
                        "components": [
                            {
                                "name": "token",
                                "type": "address",
                                "internalType": "address",
                            },
                            {
                                "name": "sources",
                                "type": "tuple[]",
                                "internalType": "struct IInvisiCore.InputSource[]",
                                "components": [
                                    {
                                        "name": "treeId",
                                        "type": "uint256",
                                        "internalType": "uint256",
                                    },
                                    {
                                        "name": "merkleRoot",
                                        "type": "bytes32",
                                        "internalType": "bytes32",
                                    },
                                ],
                            },
                            {
                                "name": "nullifiers",
                                "type": "bytes32[]",
                                "internalType": "bytes32[]",
                            },
                            {
                                "name": "noteCommitments",
                                "type": "bytes32[]",
                                "internalType": "bytes32[]",
                            },
                            {
                                "name": "withdrawalAddress",
                                "type": "address",
                                "internalType": "address",
                            },
                            {
                                "name": "withdrawalAmount",
                                "type": "uint256",
                                "internalType": "uint256",
                            },
                            {
                                "name": "deadline",
                                "type": "uint256",
                                "internalType": "uint256",
                            },
                            {
                                "name": "feeRecipient",
                                "type": "address",
                                "internalType": "address",
                            },
                            {
                                "name": "feeAmount",
                                "type": "uint256",
                                "internalType": "uint256",
                            },
                        ],
                    },
                    {
                        "name": "deliveries",
                        "type": "tuple[]",
                        "internalType": "struct IInvisiCore.Delivery[]",
                        "components": [
                            {
                                "name": "ciphertext",
                                "type": "bytes",
                                "internalType": "bytes",
                            },
                            {
                                "name": "clue",
                                "type": "bytes",
                                "internalType": "bytes",
                            },
                        ],
                    },
                    {
                        "name": "funding",
                        "type": "tuple",
                        "internalType": "struct IInvisiCore.FundingParams",
                        "components": [
                            {
                                "name": "payer",
                                "type": "address",
                                "internalType": "address",
                            },
                            {
                                "name": "amount",
                                "type": "uint256",
                                "internalType": "uint256",
                            },
                            {
                                "name": "sigNonce",
                                "type": "uint256",
                                "internalType": "uint256",
                            },
                            {
                                "name": "deadline",
                                "type": "uint256",
                                "internalType": "uint256",
                            },
                            {
                                "name": "signature",
                                "type": "bytes",
                                "internalType": "bytes",
                            },
                            {
                                "name": "permit",
                                "type": "tuple",
                                "internalType": "struct IMetaTx.TokenPermit",
                                "components": [
                                    {
                                        "name": "deadline",
                                        "type": "uint256",
                                        "internalType": "uint256",
                                    },
                                    {
                                        "name": "v",
                                        "type": "uint8",
                                        "internalType": "uint8",
                                    },
                                    {
                                        "name": "r",
                                        "type": "bytes32",
                                        "internalType": "bytes32",
                                    },
                                    {
                                        "name": "s",
                                        "type": "bytes32",
                                        "internalType": "bytes32",
                                    },
                                ],
                            },
                        ],
                    },
                ],
            },
            {
                "name": "i",
                "type": "tuple",
                "internalType": "struct IPaymentRouter.Intent",
                "components": [
                    {
                        "name": "payer",
                        "type": "address",
                        "internalType": "address",
                    },
                    {
                        "name": "tokenIn",
                        "type": "address",
                        "internalType": "address",
                    },
                    {
                        "name": "amountInMaximum",
                        "type": "uint256",
                        "internalType": "uint256",
                    },
                    {
                        "name": "refundRecipient",
                        "type": "address",
                        "internalType": "address",
                    },
                    {
                        "name": "relayer",
                        "type": "address",
                        "internalType": "address",
                    },
                    {
                        "name": "nonce",
                        "type": "uint256",
                        "internalType": "uint256",
                    },
                    {
                        "name": "deadline",
                        "type": "uint256",
                        "internalType": "uint256",
                    },
                    {
                        "name": "coreRequestHash",
                        "type": "bytes32",
                        "internalType": "bytes32",
                    },
                    {
                        "name": "routeHash",
                        "type": "bytes32",
                        "internalType": "bytes32",
                    },
                    {
                        "name": "mode",
                        "type": "uint8",
                        "internalType": "enum IPaymentRouter.Mode",
                    },
                ],
            },
            {
                "name": "route",
                "type": "tuple",
                "internalType": "struct IPaymentRouter.Route",
                "components": [
                    {
                        "name": "channel",
                        "type": "uint8",
                        "internalType": "enum IPaymentRouter.Channel",
                    },
                    {
                        "name": "path",
                        "type": "bytes",
                        "internalType": "bytes",
                    },
                    {
                        "name": "target",
                        "type": "address",
                        "internalType": "address",
                    },
                    {
                        "name": "data",
                        "type": "bytes",
                        "internalType": "bytes",
                    },
                ],
            },
            {
                "name": "permit",
                "type": "tuple",
                "internalType": "struct IPaymentRouter.Permit",
                "components": [
                    {
                        "name": "deadline",
                        "type": "uint256",
                        "internalType": "uint256",
                    },
                    {
                        "name": "v",
                        "type": "uint8",
                        "internalType": "uint8",
                    },
                    {
                        "name": "r",
                        "type": "bytes32",
                        "internalType": "bytes32",
                    },
                    {
                        "name": "s",
                        "type": "bytes32",
                        "internalType": "bytes32",
                    },
                ],
            },
        ],
        "outputs": [
            {
                "name": "",
                "type": "uint256",
                "internalType": "uint256",
            },
        ],
        "stateMutability": "nonpayable",
    },
    {
        "type": "function",
        "name": "payTokenFor",
        "inputs": [
            {
                "name": "proof",
                "type": "bytes",
                "internalType": "bytes",
            },
            {
                "name": "r",
                "type": "tuple",
                "internalType": "struct IInvisiCore.TransactRequest",
                "components": [
                    {
                        "name": "params",
                        "type": "tuple",
                        "internalType": "struct IInvisiCore.CrossTreeTransactParams",
                        "components": [
                            {
                                "name": "token",
                                "type": "address",
                                "internalType": "address",
                            },
                            {
                                "name": "sources",
                                "type": "tuple[]",
                                "internalType": "struct IInvisiCore.InputSource[]",
                                "components": [
                                    {
                                        "name": "treeId",
                                        "type": "uint256",
                                        "internalType": "uint256",
                                    },
                                    {
                                        "name": "merkleRoot",
                                        "type": "bytes32",
                                        "internalType": "bytes32",
                                    },
                                ],
                            },
                            {
                                "name": "nullifiers",
                                "type": "bytes32[]",
                                "internalType": "bytes32[]",
                            },
                            {
                                "name": "noteCommitments",
                                "type": "bytes32[]",
                                "internalType": "bytes32[]",
                            },
                            {
                                "name": "withdrawalAddress",
                                "type": "address",
                                "internalType": "address",
                            },
                            {
                                "name": "withdrawalAmount",
                                "type": "uint256",
                                "internalType": "uint256",
                            },
                            {
                                "name": "deadline",
                                "type": "uint256",
                                "internalType": "uint256",
                            },
                            {
                                "name": "feeRecipient",
                                "type": "address",
                                "internalType": "address",
                            },
                            {
                                "name": "feeAmount",
                                "type": "uint256",
                                "internalType": "uint256",
                            },
                        ],
                    },
                    {
                        "name": "deliveries",
                        "type": "tuple[]",
                        "internalType": "struct IInvisiCore.Delivery[]",
                        "components": [
                            {
                                "name": "ciphertext",
                                "type": "bytes",
                                "internalType": "bytes",
                            },
                            {
                                "name": "clue",
                                "type": "bytes",
                                "internalType": "bytes",
                            },
                        ],
                    },
                    {
                        "name": "funding",
                        "type": "tuple",
                        "internalType": "struct IInvisiCore.FundingParams",
                        "components": [
                            {
                                "name": "payer",
                                "type": "address",
                                "internalType": "address",
                            },
                            {
                                "name": "amount",
                                "type": "uint256",
                                "internalType": "uint256",
                            },
                            {
                                "name": "sigNonce",
                                "type": "uint256",
                                "internalType": "uint256",
                            },
                            {
                                "name": "deadline",
                                "type": "uint256",
                                "internalType": "uint256",
                            },
                            {
                                "name": "signature",
                                "type": "bytes",
                                "internalType": "bytes",
                            },
                            {
                                "name": "permit",
                                "type": "tuple",
                                "internalType": "struct IMetaTx.TokenPermit",
                                "components": [
                                    {
                                        "name": "deadline",
                                        "type": "uint256",
                                        "internalType": "uint256",
                                    },
                                    {
                                        "name": "v",
                                        "type": "uint8",
                                        "internalType": "uint8",
                                    },
                                    {
                                        "name": "r",
                                        "type": "bytes32",
                                        "internalType": "bytes32",
                                    },
                                    {
                                        "name": "s",
                                        "type": "bytes32",
                                        "internalType": "bytes32",
                                    },
                                ],
                            },
                        ],
                    },
                ],
            },
            {
                "name": "i",
                "type": "tuple",
                "internalType": "struct IPaymentRouter.Intent",
                "components": [
                    {
                        "name": "payer",
                        "type": "address",
                        "internalType": "address",
                    },
                    {
                        "name": "tokenIn",
                        "type": "address",
                        "internalType": "address",
                    },
                    {
                        "name": "amountInMaximum",
                        "type": "uint256",
                        "internalType": "uint256",
                    },
                    {
                        "name": "refundRecipient",
                        "type": "address",
                        "internalType": "address",
                    },
                    {
                        "name": "relayer",
                        "type": "address",
                        "internalType": "address",
                    },
                    {
                        "name": "nonce",
                        "type": "uint256",
                        "internalType": "uint256",
                    },
                    {
                        "name": "deadline",
                        "type": "uint256",
                        "internalType": "uint256",
                    },
                    {
                        "name": "coreRequestHash",
                        "type": "bytes32",
                        "internalType": "bytes32",
                    },
                    {
                        "name": "routeHash",
                        "type": "bytes32",
                        "internalType": "bytes32",
                    },
                    {
                        "name": "mode",
                        "type": "uint8",
                        "internalType": "enum IPaymentRouter.Mode",
                    },
                ],
            },
            {
                "name": "route",
                "type": "tuple",
                "internalType": "struct IPaymentRouter.Route",
                "components": [
                    {
                        "name": "channel",
                        "type": "uint8",
                        "internalType": "enum IPaymentRouter.Channel",
                    },
                    {
                        "name": "path",
                        "type": "bytes",
                        "internalType": "bytes",
                    },
                    {
                        "name": "target",
                        "type": "address",
                        "internalType": "address",
                    },
                    {
                        "name": "data",
                        "type": "bytes",
                        "internalType": "bytes",
                    },
                ],
            },
            {
                "name": "permit",
                "type": "tuple",
                "internalType": "struct IPaymentRouter.Permit",
                "components": [
                    {
                        "name": "deadline",
                        "type": "uint256",
                        "internalType": "uint256",
                    },
                    {
                        "name": "v",
                        "type": "uint8",
                        "internalType": "uint8",
                    },
                    {
                        "name": "r",
                        "type": "bytes32",
                        "internalType": "bytes32",
                    },
                    {
                        "name": "s",
                        "type": "bytes32",
                        "internalType": "bytes32",
                    },
                ],
            },
            {
                "name": "signature",
                "type": "bytes",
                "internalType": "bytes",
            },
        ],
        "outputs": [
            {
                "name": "",
                "type": "uint256",
                "internalType": "uint256",
            },
        ],
        "stateMutability": "nonpayable",
    },
    {
        "type": "function",
        "name": "settlerRegistry",
        "inputs": [],
        "outputs": [
            {
                "name": "",
                "type": "address",
                "internalType": "address",
            },
        ],
        "stateMutability": "view",
    },
    {
        "type": "function",
        "name": "weth",
        "inputs": [],
        "outputs": [
            {
                "name": "",
                "type": "address",
                "internalType": "contract IWETH9",
            },
        ],
        "stateMutability": "view",
    },
    {
        "type": "event",
        "name": "EIP712DomainChanged",
        "inputs": [],
        "anonymous": false,
    },
    {
        "type": "event",
        "name": "NoncesInvalidated",
        "inputs": [
            {
                "name": "payer",
                "type": "address",
                "indexed": true,
                "internalType": "address",
            },
            {
                "name": "newNonce",
                "type": "uint256",
                "indexed": false,
                "internalType": "uint256",
            },
        ],
        "anonymous": false,
    },
    {
        "type": "event",
        "name": "Payment",
        "inputs": [
            {
                "name": "payer",
                "type": "address",
                "indexed": true,
                "internalType": "address",
            },
            {
                "name": "tokenIn",
                "type": "address",
                "indexed": true,
                "internalType": "address",
            },
            {
                "name": "tokenOut",
                "type": "address",
                "indexed": true,
                "internalType": "address",
            },
            {
                "name": "refundRecipient",
                "type": "address",
                "indexed": false,
                "internalType": "address",
            },
            {
                "name": "fundingAmount",
                "type": "uint256",
                "indexed": false,
                "internalType": "uint256",
            },
            {
                "name": "amountSpent",
                "type": "uint256",
                "indexed": false,
                "internalType": "uint256",
            },
            {
                "name": "nonce",
                "type": "uint256",
                "indexed": false,
                "internalType": "uint256",
            },
            {
                "name": "mode",
                "type": "uint8",
                "indexed": false,
                "internalType": "enum IPaymentRouter.Mode",
            },
        ],
        "anonymous": false,
    },
    {
        "type": "error",
        "name": "AddressEmptyCode",
        "inputs": [
            {
                "name": "target",
                "type": "address",
                "internalType": "address",
            },
        ],
    },
    {
        "type": "error",
        "name": "AddressInsufficientBalance",
        "inputs": [
            {
                "name": "account",
                "type": "address",
                "internalType": "address",
            },
        ],
    },
    {
        "type": "error",
        "name": "FailedInnerCall",
        "inputs": [],
    },
    {
        "type": "error",
        "name": "InexactReceipt",
        "inputs": [],
    },
    {
        "type": "error",
        "name": "InexactReceipt",
        "inputs": [],
    },
    {
        "type": "error",
        "name": "InexactSettlement",
        "inputs": [],
    },
    {
        "type": "error",
        "name": "InexactSwapReceipt",
        "inputs": [],
    },
    {
        "type": "error",
        "name": "InexactSwapSpend",
        "inputs": [],
    },
    {
        "type": "error",
        "name": "InvalidDeployment",
        "inputs": [],
    },
    {
        "type": "error",
        "name": "InvalidIntent",
        "inputs": [],
    },
    {
        "type": "error",
        "name": "InvalidNativeBalance",
        "inputs": [],
    },
    {
        "type": "error",
        "name": "InvalidNativeCheck",
        "inputs": [],
    },
    {
        "type": "error",
        "name": "InvalidPath",
        "inputs": [],
    },
    {
        "type": "error",
        "name": "InvalidQuote",
        "inputs": [],
    },
    {
        "type": "error",
        "name": "InvalidQuote",
        "inputs": [],
    },
    {
        "type": "error",
        "name": "InvalidRefund",
        "inputs": [],
    },
    {
        "type": "error",
        "name": "InvalidRequest",
        "inputs": [],
    },
    {
        "type": "error",
        "name": "InvalidRoute",
        "inputs": [],
    },
    {
        "type": "error",
        "name": "InvalidShortString",
        "inputs": [],
    },
    {
        "type": "error",
        "name": "InvalidSignature",
        "inputs": [],
    },
    {
        "type": "error",
        "name": "InvalidSpend",
        "inputs": [],
    },
    {
        "type": "error",
        "name": "InvalidTarget",
        "inputs": [],
    },
    {
        "type": "error",
        "name": "InvalidTarget",
        "inputs": [],
    },
    {
        "type": "error",
        "name": "ReentrancyGuardReentrantCall",
        "inputs": [],
    },
    {
        "type": "error",
        "name": "RefundFailed",
        "inputs": [],
    },
    {
        "type": "error",
        "name": "SafeERC20FailedOperation",
        "inputs": [
            {
                "name": "token",
                "type": "address",
                "internalType": "address",
            },
        ],
    },
    {
        "type": "error",
        "name": "StringTooLong",
        "inputs": [
            {
                "name": "str",
                "type": "string",
                "internalType": "string",
            },
        ],
    },
    {
        "type": "error",
        "name": "UnexpectedETH",
        "inputs": [],
    },
    {
        "type": "error",
        "name": "ZeroExFailed",
        "inputs": [],
    },
    {
        "type": "error",
        "name": "ZeroExFailed",
        "inputs": [],
    },
] as const;

export const paymentRouterAccountAbi = [
    {
        "type": "constructor",
        "inputs": [
            {
                "name": "router_",
                "type": "address",
                "internalType": "address",
            },
        ],
        "stateMutability": "nonpayable",
    },
    {
        "type": "receive",
        "stateMutability": "payable",
    },
    {
        "type": "function",
        "name": "NATIVE_PAYMENT_TYPEHASH",
        "inputs": [],
        "outputs": [
            {
                "name": "",
                "type": "bytes32",
                "internalType": "bytes32",
            },
        ],
        "stateMutability": "view",
    },
    {
        "type": "function",
        "name": "domainSeparator",
        "inputs": [],
        "outputs": [
            {
                "name": "",
                "type": "bytes32",
                "internalType": "bytes32",
            },
        ],
        "stateMutability": "view",
    },
    {
        "type": "function",
        "name": "executeNativePayment",
        "inputs": [
            {
                "name": "routerCalldata",
                "type": "bytes",
                "internalType": "bytes",
            },
            {
                "name": "value",
                "type": "uint256",
                "internalType": "uint256",
            },
            {
                "name": "nonce_",
                "type": "uint256",
                "internalType": "uint256",
            },
            {
                "name": "deadline",
                "type": "uint256",
                "internalType": "uint256",
            },
            {
                "name": "relayer",
                "type": "address",
                "internalType": "address",
            },
            {
                "name": "signature",
                "type": "bytes",
                "internalType": "bytes",
            },
        ],
        "outputs": [
            {
                "name": "spent",
                "type": "uint256",
                "internalType": "uint256",
            },
        ],
        "stateMutability": "payable",
    },
    {
        "type": "function",
        "name": "hashNativePayment",
        "inputs": [
            {
                "name": "routerCalldata",
                "type": "bytes",
                "internalType": "bytes",
            },
            {
                "name": "value",
                "type": "uint256",
                "internalType": "uint256",
            },
            {
                "name": "nonce_",
                "type": "uint256",
                "internalType": "uint256",
            },
            {
                "name": "deadline",
                "type": "uint256",
                "internalType": "uint256",
            },
            {
                "name": "relayer",
                "type": "address",
                "internalType": "address",
            },
        ],
        "outputs": [
            {
                "name": "",
                "type": "bytes32",
                "internalType": "bytes32",
            },
        ],
        "stateMutability": "view",
    },
    {
        "type": "function",
        "name": "implementation",
        "inputs": [],
        "outputs": [
            {
                "name": "",
                "type": "address",
                "internalType": "address",
            },
        ],
        "stateMutability": "view",
    },
    {
        "type": "function",
        "name": "isValidSignature",
        "inputs": [
            {
                "name": "hash",
                "type": "bytes32",
                "internalType": "bytes32",
            },
            {
                "name": "signature",
                "type": "bytes",
                "internalType": "bytes",
            },
        ],
        "outputs": [
            {
                "name": "",
                "type": "bytes4",
                "internalType": "bytes4",
            },
        ],
        "stateMutability": "view",
    },
    {
        "type": "function",
        "name": "nonce",
        "inputs": [],
        "outputs": [
            {
                "name": "",
                "type": "uint256",
                "internalType": "uint256",
            },
        ],
        "stateMutability": "view",
    },
    {
        "type": "function",
        "name": "router",
        "inputs": [],
        "outputs": [
            {
                "name": "",
                "type": "address",
                "internalType": "address",
            },
        ],
        "stateMutability": "view",
    },
    {
        "type": "function",
        "name": "routerCodeHash",
        "inputs": [],
        "outputs": [
            {
                "name": "",
                "type": "bytes32",
                "internalType": "bytes32",
            },
        ],
        "stateMutability": "view",
    },
    {
        "type": "error",
        "name": "Expired",
        "inputs": [],
    },
    {
        "type": "error",
        "name": "InvalidDelegation",
        "inputs": [],
    },
    {
        "type": "error",
        "name": "InvalidNonce",
        "inputs": [],
    },
    {
        "type": "error",
        "name": "InvalidRelayer",
        "inputs": [],
    },
    {
        "type": "error",
        "name": "InvalidRouter",
        "inputs": [],
    },
    {
        "type": "error",
        "name": "InvalidRouterCall",
        "inputs": [],
    },
    {
        "type": "error",
        "name": "InvalidSignature",
        "inputs": [],
    },
    {
        "type": "error",
        "name": "ReentrantExecution",
        "inputs": [],
    },
    {
        "type": "error",
        "name": "RouterCodeChanged",
        "inputs": [],
    },
    {
        "type": "error",
        "name": "UnexpectedValue",
        "inputs": [],
    },
] as const;
