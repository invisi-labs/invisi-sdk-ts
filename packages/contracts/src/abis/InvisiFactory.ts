export const invisiFactoryAbi = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "globalEmergency_",
        "type": "address"
      },
      {
        "name": "verifierRouter_",
        "type": "address"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "VERSION",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "computeInstanceAddress",
    "inputs": [
      {
        "name": "operator",
        "type": "address"
      },
      {
        "name": "token",
        "type": "address"
      },
      {
        "name": "params",
        "type": "tuple",
        "components": [
          {
            "name": "factory",
            "type": "address"
          },
          {
            "name": "token",
            "type": "address"
          },
          {
            "name": "globalEmergency",
            "type": "address"
          },
          {
            "name": "emergencyAdmin",
            "type": "address"
          },
          {
            "name": "timelockAdmin",
            "type": "address"
          },
          {
            "name": "maxPerDeposit",
            "type": "uint256"
          },
          {
            "name": "verifierRouter",
            "type": "address"
          }
        ]
      }
    ],
    "outputs": [
      {
        "name": "instance",
        "type": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "deploy",
    "inputs": [
      {
        "name": "token",
        "type": "address"
      },
      {
        "name": "emergencyAdmin",
        "type": "address"
      },
      {
        "name": "timelockAdmin",
        "type": "address"
      },
      {
        "name": "maxPerDeposit",
        "type": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "instance",
        "type": "address"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "emergencyPauseAll",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "emergencyPauseInstance",
    "inputs": [
      {
        "name": "instance",
        "type": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "getInstanceAddress",
    "inputs": [
      {
        "name": "operator",
        "type": "address"
      },
      {
        "name": "token",
        "type": "address"
      }
    ],
    "outputs": [
      {
        "name": "instance",
        "type": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "globalEmergency",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "isInstance",
    "inputs": [
      {
        "name": "",
        "type": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "verifierRouter",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "event",
    "name": "EmergencyPauseAll",
    "inputs": [
      {
        "name": "instanceCount",
        "type": "uint256",
        "indexed": false
      }
    ]
  },
  {
    "type": "event",
    "name": "EmergencyPauseInstance",
    "inputs": [
      {
        "name": "instance",
        "type": "address",
        "indexed": true
      }
    ]
  },
  {
    "type": "event",
    "name": "InstanceDeployed",
    "inputs": [
      {
        "name": "operator",
        "type": "address",
        "indexed": true
      },
      {
        "name": "token",
        "type": "address",
        "indexed": true
      },
      {
        "name": "instance",
        "type": "address",
        "indexed": false
      }
    ]
  },
  {
    "type": "error",
    "name": "InstanceAlreadyDeployed",
    "inputs": [
      {
        "name": "operator",
        "type": "address"
      },
      {
        "name": "token",
        "type": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "NotAnInstance",
    "inputs": [
      {
        "name": "addr",
        "type": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "NotGlobalEmergency",
    "inputs": []
  }
] as const
