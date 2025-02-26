import { Client, GatewayIntentBits } from "discord.js";
import dotenv from "dotenv";
import { ethers } from "ethers";
dotenv.config({ path: ".env.local" });

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

if (
  !process.env.PRIVATE_KEY_1 ||
  !process.env.PRIVATE_KEY_2 ||
  !process.env.PRIVATE_KEY_3
) {
  throw new Error("Missing private keys in environment variables");
}

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);

const FAUCET_AMOUNT = ethers.parseEther("0.05");
const COOLDOWN_PERIOD = 12 * 60 * 60 * 1000;
const lastRequests = new Map();
const userLastResets = new Map();

const wallets = [
  new ethers.Wallet(process.env.PRIVATE_KEY_1, provider),
  new ethers.Wallet(process.env.PRIVATE_KEY_2, provider),
  new ethers.Wallet(process.env.PRIVATE_KEY_3, provider),
];

const txQueue = [];
let processing = false;
const nonceTracker = new Map(wallets.map((wallet) => [wallet.address, null]));

const AUTHORIZED_ROLE_IDS = [
  "1202897827232219176",
  "1218983061014839346",
  "1260311106992476331",
];

const TOTAL_LIMIT = ethers.parseEther("300");
const MAX_WALLET_BALANCE = ethers.parseEther("10");
const userTotalReceived = new Map();

const AUTHORIZED_CHANNEL_IDS = ["1343593091424325717", "1343932669473325167"];

const FAUCET_ROLE_IDS = [
  "1327363963700121631",
  "1260311106992476331",
  "1209447876652961823",
  "1210927185855127582",
  "1330859388071575583",
  "1212732543447867432",
  "1321088327130026085",
  "1210935213690200125",
  "1202897827232219176",
  "1218983061014839346",
];

let totalSentOverall = ethers.parseEther("0");
let lastResetTime = Date.now();
const RESET_INTERVAL = 12 * 60 * 60 * 1000;

function checkAndResetDaily() {
  const currentTime = Date.now();
  if (currentTime - lastResetTime >= RESET_INTERVAL) {
    totalSentOverall = ethers.parseEther("0");
    userTotalReceived.clear();
    lastResetTime = currentTime;
    console.log("Daily global limit has been reset");
  }
}

function checkAndResetUserLimit(userId) {
  const currentTime = Date.now();
  const userLastReset = userLastResets.get(userId) || 0;

  if (currentTime - userLastReset >= COOLDOWN_PERIOD) {
    lastRequests.delete(userId);
    userLastResets.set(userId, currentTime);
    return true;
  }
  return false;
}

async function processQueue() {
  if (processing || txQueue.length === 0) return;
  processing = true;

  while (txQueue.length > 0) {
    const { address, amount, message } = txQueue[0];
    const availableWallet = await getAvailableWallet();
    if (!availableWallet) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      continue;
    }

    try {
      const currentNonce = await provider.getTransactionCount(
        availableWallet.address
      );
      nonceTracker.set(availableWallet.address, currentNonce);

      const tx = await availableWallet.sendTransaction({
        to: address,
        value: amount,
        nonce: currentNonce,
      });

      console.log(
        `Transaction sent from ${availableWallet.address}: ${tx.hash}`
      );

      await message.react("✅");
      totalSentOverall = totalSentOverall + FAUCET_AMOUNT;
      txQueue.shift();
    } catch (error) {
      console.error("Transaction failed:", error);

      if (
        error.code === "UNKNOWN_ERROR" ||
        error.message?.includes("failed to serve request")
      ) {
        console.log("RPC error detected, waiting 5 seconds before retry...");
        await new Promise((resolve) => setTimeout(resolve, 5000));
        continue;
      }

      await message.react("❌");
      txQueue.shift();
    }
  }

  processing = false;
}

async function getAvailableWallet() {
  for (const wallet of wallets) {
    const balance = await provider.getBalance(wallet.address);
    if (balance >= FAUCET_AMOUNT) {
      return wallet;
    }
  }
  return null;
}

client.once("ready", () => {
  console.log("Discord Faucet Bot Started");
  console.log(`Connected as: ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  checkAndResetDaily();

  if (!AUTHORIZED_CHANNEL_IDS.includes(message.channel.id)) {
    return;
  }

  const hasAuthorizedRole = message.member.roles.cache.some((role) =>
    AUTHORIZED_ROLE_IDS.includes(role.id)
  );

  if (message.content === "!balance") {
    if (!hasAuthorizedRole) {
      await message.reply("You don't have permission to use this command.");
      return;
    }
    try {
      let balanceMessage = "**Faucet wallets balance:**\n";

      for (const wallet of wallets) {
        const balance = await provider.getBalance(wallet.address);
        balanceMessage += `\`${wallet.address}\`: ${ethers.formatEther(
          balance
        )} MON\n`;
      }

      await message.reply(balanceMessage);
      return;
    } catch (error) {
      console.error("Error while fetching balances:", error);
      await message.reply("An error occurred while fetching the balances.");
      return;
    }
  }

  if (message.content.startsWith("!give-mon")) {
    if (!hasAuthorizedRole) {
      await message.reply("You don't have permission to use this command.");
      return;
    }

    const args = message.content.split(" ");
    if (args.length !== 3) {
      await message.reply("Format: !give-mon <address> <amount>");
      return;
    }

    const address = args[1];
    const amount = ethers.parseEther(args[2]);

    if (!address.match(/0x[a-fA-F0-9]{40}/)) {
      await message.reply("Invalid EVM address");
      return;
    }

    txQueue.push({
      address,
      amount,
      message,
    });

    processQueue();
    return;
  }

  if (message.content === "!daily") {
    if (!hasAuthorizedRole) {
      await message.reply("You don't have permission to use this command.");
      return;
    }

    const ethAddressMatch = message.channel.messages.cache
      .filter((msg) => msg.author.id === message.author.id)
      .find((msg) => msg.content.match(/0x[a-fA-F0-9]{40}/));

    if (!ethAddressMatch) {
      await message.reply(
        "No ETH address found in your recent messages. Please send an address first."
      );
      return;
    }

    const address = ethAddressMatch.content.match(/0x[a-fA-F0-9]{40}/)[0];
    const totalReceived =
      userTotalReceived.get(address) || ethers.parseEther("0");
    const remaining = TOTAL_LIMIT - totalReceived;

    const timeUntilReset = RESET_INTERVAL - (Date.now() - lastResetTime);
    const hoursUntilReset = Math.floor(timeUntilReset / (60 * 60 * 1000));
    const minutesUntilReset = Math.floor(
      (timeUntilReset % (60 * 60 * 1000)) / (60 * 1000)
    );

    await message.reply(
      `Status pour l'adresse ${address}:\n` +
        `Total reçu: ${ethers.formatEther(totalReceived)} MON\n` +
        `Restant jusqu'à la limite: ${ethers.formatEther(remaining)} MON\n` +
        `Temps restant avant réinitialisation: ${hoursUntilReset}h ${minutesUntilReset}m`
    );
    return;
  }

  const ethAddressMatch = message.content.match(/0x[a-fA-F0-9]{40}/);
  if (!ethAddressMatch) return;

  const hasFaucetRole = message.member.roles.cache.some((role) =>
    FAUCET_ROLE_IDS.includes(role.id)
  );

  if (!hasFaucetRole) {
    await message.reply("You don't have permission to use the faucet.");
    return;
  }

  const address = ethAddressMatch[0];
  const userId = message.author.id;

  const totalReceived =
    userTotalReceived.get(address) || ethers.parseEther("0");
  if (totalReceived >= TOTAL_LIMIT) {
    await message.reply(
      `This address has reached the maximum limit of 300 MON.`
    );
    await message.react("❌");
    return;
  }

  const lastRequest = lastRequests.get(userId);
  if (lastRequest) {
    const timeLeft = COOLDOWN_PERIOD - (Date.now() - lastRequest);
    if (timeLeft > 0) {
      const hoursLeft = Math.floor(timeLeft / (60 * 60 * 1000));
      const minutesLeft = Math.floor(
        (timeLeft % (60 * 60 * 1000)) / (60 * 1000)
      );
      await message.reply(
        `Please wait ${hoursLeft}h ${minutesLeft}m before requesting again.`
      );
      await message.react("⏳");
      return;
    } else {
      lastRequests.delete(userId);
    }
  }

  try {
    const recipientBalance = await provider.getBalance(address);
    if (recipientBalance >= MAX_WALLET_BALANCE) {
      console.log(`Address already has sufficient balance`);
      await message.reply(
        `This address already has sufficient balance (${ethers.formatEther(
          recipientBalance
        )} MON)`
      );
      return;
    }

    const amountToSend = FAUCET_AMOUNT;
    const newTotalSent = totalSentOverall + amountToSend;

    if (newTotalSent > TOTAL_LIMIT) {
      await message.reply(`Daily limit reached. Please try again tomorrow.`);
      await message.react("❌");
      return;
    }

    if (!userLastResets.has(userId)) {
      userLastResets.set(userId, Date.now());
    }

    lastRequests.set(userId, Date.now());
    totalSentOverall = newTotalSent;

    const currentTotal =
      userTotalReceived.get(address) || ethers.parseEther("0");
    userTotalReceived.set(address, currentTotal + FAUCET_AMOUNT);

    txQueue.push({
      address,
      amount: amountToSend,
      message,
    });

    processQueue();
  } catch (error) {
    console.error("Error:", error);
    await message.react("❌");
  }
});

client.on("error", (error) => {
  console.error("DISCORD ERROR:", error);
});

client.login(process.env.DISCORD_TOKEN);
