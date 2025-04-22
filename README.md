# Solana Copytrading Bot

This project is a copytrading bot on the Solana blockchain that monitors and automatically replicates trades using PumpPortal, Raydium, and PumpSwap services. The bot sends real-time trade notifications via Telegram.

## Key Features

- Wallet Monitoring: Tracks trades of a specified wallet on Solana.
- Automated Trade Copying: Replicates buy and sell transactions via PumpPortal, Raydium, and PumpSwap.
- Telegram Notifications: Sends messages for each trade with details (token, amount, transaction link).
- Flexible Configuration: Supports configuration via a `.env` file for API keys, wallets, and other parameters.

## Requirements

- Node.js and npm installed.
- A Solana wallet with sufficient SOL for transactions.
- API keys for PumpPortal, Raydium, and other services (see `env.example`).
- A Telegram bot and chat ID for notifications.

## Obtaining Public and Private Keys via PumpPortal

To work with PumpPortal (e.g., via their Trading API), you need to create a wallet and obtain an API key. PumpPortal automatically generates a wallet with public and private keys. Here's how to do it:

1. Visit the PumpPortal Website:

   - Go to `https://pumpportal.fun` and navigate to the API section (e.g., "Get Started" or "Generate API Key").

2. Generate a Wallet and API Key:

   - Click the button to create a new wallet ("Generate a Lightning Wallet & API Key").
   - PumpPortal will generate a new Solana wallet and provide you with:
     - Public Key (wallet address, e.g., `AArPXm8JatJiuyEffuC1un2Sc835SULa4uQqDcaGpAjV`).
     - Private Key (the wallet's secret key, e.g., in Base58 format).
     - API Key (for accessing the Trading API).

3. Securely Save the Keys:

   - Immediately copy and save the public key, private key, and API key in a secure location (e.g., an encrypted file or password manager).
   - Important: PumpPortal warns that the keys will disappear if you refresh the page or generate new ones. They cannot be recovered if lost.

4. Add the Keys to `.env`:

   - Open the `.env` file and add:

     ```
     PUMPPORTAL_PUBLIC_KEY=your_public_key
     PUMPPORTAL_PRIVATE_KEY=your_private_key
     PUMPPORTAL_API_KEY=your_api_key
     ```


5. Fund the Wallet:

   - Send some SOL to the public key of the wallet to use it for trading via the PumpPortal API.

## Installation

1. Clone the repository:
'''git clone https://github.com/Iluasarg/copytrading-bot.git
cd copytrading-bot'''

4. Install dependencies:
'''npm install'''

5. Create a `.env` file based on the `env.example` template and fill in your details:


Open `.env` and add your API keys, wallet details, and Telegram information.

4. Important: This bot requires the `config.ts` file to function, which is not included in the repository for security reasons. To purchase the `config.ts` file, contact me at [your-email@example.com]. The cost is [specify your price].

## Usage

1. After obtaining the `config.ts` file, place it in the `src` folder.

2. Run the bot:
'''npm start'''


3. The bot will start monitoring the specified wallet and replicating trades, sending notifications to Telegram.

## Notes

- Ensure your wallet has enough SOL to cover transaction fees.
- Regularly check Telegram notifications to monitor trades.
- For support or inquiries, email [your-email@example.com].




