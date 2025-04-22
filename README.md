

## 🚀 Solana Copytrading Bot — Automatically Mirror Top Traders on Solana

Want to earn by following smart money?  
**Solana Copytrading Bot** is a powerful tool that tracks and mirrors trades of any wallet **in real time** across **three major platforms**: **PumpPortal**, **Raydium**, and **PumpSwap**. With ultra-low latency — just **1–2 blocks** — thanks to **Jito**, you get almost the same entry point as the original trader.

---

### 🔥 Why This Bot Stands Out

- **Three Platforms, Not Just One**  
  Most copytrading bots work with only one service. Ours supports all the main ones where real copytrading happens. **More coverage = more profit opportunities**.

- **Ultra-Fast Reaction Time**  
  With Jito integration, the bot reacts faster than most network participants — **enters trades just 1–2 blocks** after the original wallet.

- **Smart Trade Copying**  
  The bot automatically mirrors both buys and sells of the target wallet, matching tokens and volumes with precision.

- **Telegram Notifications**  
  Every trade is instantly reported to your Telegram — token name, amount, transaction link, and more.

- **Easy & Flexible Setup**  
  Everything is configured through `.env`. No complicated configs. Just plug and play — get started in 5 minutes.

---

### 🔧 Installation & Launch

1. Clone the repository:

```bash
git clone https://github.com/Iluasarg/copytrading-bot.git
cd copytrading-bot
```

2. Install dependencies:

```bash
npm install
```

3. Create a `.env` file based on `env.example` and fill in your API keys, wallet details, and Telegram bot info.

4. Run the bot:

```bash
npm start
```

The bot will begin monitoring the specified wallet and mirroring its trades. All actions will be sent to Telegram in real time.

---

### 🪪 How to Get PumpPortal Keys and Wallet

To use PumpPortal’s Trading API, you’ll need an API key and wallet credentials. Here’s how to get them:

1. Go to [pumpportal.fun](https://pumpportal.fun)  
2. Click **“Generate a Lightning Wallet & API Key”**  
   This will generate:
   - **Public Key** — your Solana wallet address  
   - **Private Key** — the secret key (Base58 format)  
   - **API Key** — to access the PumpPortal API  
3. **Important:** Copy and save them **immediately**. If you refresh the page, they’re gone forever!  
4. Add them to your `.env` file:

```env
PUMPPORTAL_PUBLIC_KEY=your_public_key
PUMPPORTAL_PRIVATE_KEY=your_private_key
PUMPPORTAL_API_KEY=your_api_key
```

5. Fund your wallet with some SOL to cover transaction fees and enable trading.

---

📲 Now you’re ready to copy top traders on Solana with just a few clicks.  
This bot is perfect for arbitrageurs, DeFi traders, and anyone looking to **enter trades fast, precisely, and automatically**.

---

💬 Got questions or want to get the bot now?  
🔹 [Message me on Telegram](https://t.me/iluasarg)
