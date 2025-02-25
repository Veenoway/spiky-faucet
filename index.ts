import { Client, GatewayIntentBits, Message } from "discord.js";
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

const DISCORD_TOKEN: string | undefined = process.env.DISCORD_TOKEN;
const PROVIDER_URL: string | undefined = process.env.PROVIDER_URL;
const PRIVATE_KEY: string | undefined = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS: string | undefined = process.env.CONTRACT_ADDRESS;

if (!DISCORD_TOKEN || !PROVIDER_URL || !PRIVATE_KEY || !CONTRACT_ADDRESS) {
  throw new Error("Env variable missing");
}

const ABI: string[] = [
  "function faucet(address payable to) external",
  "function giveMon(address payable to, uint256 amount) external",
];

const provider = new ethers.JsonRpcProvider(PROVIDER_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const faucetContract = new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet);

const claimCooldown: Map<string, number> = new Map();

const allowedChannelIds: string[] = [
  "1343932669473325167",
  "1343593091424325717",
];

const allowedFaucetRoles: string[] = [
  "1212732543447867432",
  "1209447876652961823",
  "1330859388071575583",
  "1210935213690200125",
  "1202897827232219176",
  "1260311106992476331",
  "1210927185855127582",
  "1327363963700121631",
  "1218983061014839346",
];

const allowedGiveMonRoles: string[] = [
  "1202897827232219176",
  "1260311106992476331",
  "1218983061014839346",
];

let totalSent: bigint = ethers.parseEther("0");
const MAX_SENT: bigint = ethers.parseEther("300");

function isValidAddress(address: string): boolean {
  try {
    ethers.getAddress(address);
    return true;
  } catch {
    return false;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error("Transaction timeout")), ms)
    ),
  ]);
}

interface FaucetQueueItem {
  playerAddress: string;
  message: Message;
  resolve: (txHash: string) => void;
  reject: (error: any) => void;
}

const faucetQueue: FaucetQueueItem[] = [];
let processingFaucetQueue = false;

async function processFaucetQueue() {
  if (processingFaucetQueue) return;
  processingFaucetQueue = true;

  while (faucetQueue.length > 0) {
    const item = faucetQueue.shift()!;
    try {
      const faucetAmount: bigint = ethers.parseEther("0.05");
      if (totalSent + faucetAmount > MAX_SENT) {
        throw new Error(
          "Faucet reached its daily limit. No more tokens can be sent."
        );
      }

      let nonce = await provider.getTransactionCount(wallet.address, "pending");
      let txReceipt;

      try {
        const txPromise = faucetContract
          .faucet(item.playerAddress, { nonce })
          .then((tx) => tx.wait());

        txReceipt = await withTimeout(txPromise, 60000);
      } catch (error: any) {
        if (
          error.code === "NONCE_EXPIRED" ||
          error.message.includes("Nonce too low")
        ) {
          nonce = await provider.getTransactionCount(wallet.address, "pending");
          const txPromiseRetry = faucetContract
            .faucet(item.playerAddress, { nonce })
            .then((tx) => tx.wait());

          txReceipt = await withTimeout(txPromiseRetry, 60000);
        } else {
          throw error;
        }
      }

      totalSent += faucetAmount;
      const userId = item.message.author.id;
      claimCooldown.set(userId, Date.now());

      item.resolve(txReceipt.transactionHash);
    } catch (error) {
      item.reject(error);
    }
  }

  processingFaucetQueue = false;
}

client.on("messageCreate", async (message: Message) => {
  if (message.author.bot) return;
  if (!allowedChannelIds.includes(message.channel.id)) return;

  const args = message.content.split(" ");
  const command = args[0];

  const hasFaucetRole = message.member?.roles.cache.some((role) =>
    allowedFaucetRoles.includes(role.id)
  );

  const hasGiveMonRole = message.member?.roles.cache.some((role) =>
    allowedGiveMonRoles.includes(role.id)
  );

  if (command === "!faucet") {
    if (!hasFaucetRole) {
      await message.reply("You aren't allowed to use the faucet command.");
      return;
    }

    if (args.length < 2) {
      await message.reply("Invalid EVM address. Usage: !faucet <address>");
      return;
    }

    const userEthAddress = args[1];
    if (!isValidAddress(userEthAddress)) {
      await message.reply("Invalid EVM address. Usage: !faucet <address>");
      return;
    }

    const userId = message.author.id;
    const now = Date.now();
    const cooldownDuration = 24 * 60 * 60 * 1000;
    if (claimCooldown.has(userId)) {
      const lastClaim = claimCooldown.get(userId)!;
      if (now < lastClaim + cooldownDuration) {
        await message.reply("Faucet can be claimed once every 24h.");
        return;
      }
    }

    const faucetAmount: bigint = ethers.parseEther("0.05");
    if (totalSent + faucetAmount > MAX_SENT) {
      await message.reply(
        "Faucet reached its daily limit. No more tokens can be sent."
      );
      return;
    }

    const txPromise = new Promise<string>((resolve, reject) => {
      faucetQueue.push({
        playerAddress: userEthAddress,
        message,
        resolve,
        reject,
      });
    });
    processFaucetQueue();

    try {
      const txHash = await txPromise;
      await message.react("✅");
      console.log("Faucet transaction successful:", txHash);
    } catch (error: any) {
      console.error("Error while processing faucet:", error);
      await message.react("❌");
      await message.reply(
        "An error occurred while processing your faucet request."
      );
    }
  }

  if (command === "!give-mon") {
    if (!hasGiveMonRole) {
      await message.reply("You aren't allowed to use this command.");
      return;
    }
    if (args.length < 3) {
      await message.reply("Usage: !give-mon <address> <amount>");
      return;
    }
    const targetAddress = args[1];
    const amountInput = args[2];
    if (!isValidAddress(targetAddress)) {
      await message.reply("Invalid target EVM address.");
      return;
    }
    try {
      const amount: bigint = ethers.parseUnits(amountInput, 18);
      if (totalSent + amount > MAX_SENT) {
        await message.reply(
          "Faucet reached its daily limit. No more tokens can be sent."
        );
        return;
      }
      const nonce = await provider.getTransactionCount(
        wallet.address,
        "pending"
      );
      const tx = await faucetContract.giveMon(targetAddress, amount, { nonce });
      await tx.wait();
      totalSent += amount;
      await message.react("✅");
      console.log("give-mon transaction successful:", tx.hash);
    } catch (error: any) {
      console.error("Error while processing give-mon:", error);
      await message.reply(
        "An error occurred while processing your give-mon request."
      );
    }
  }

  if (command === "!daily") {
    if (!hasGiveMonRole) {
      await message.reply("You aren't allowed to use this command.");
      return;
    }
    const remaining: bigint = MAX_SENT - totalSent;
    if (remaining <= ethers.parseEther("0")) {
      await message.reply("Faucet reached its daily limit.");
    } else {
      const formattedRemaining = ethers.formatEther(remaining);
      await message.reply(
        `Remaining tokens for today: ${formattedRemaining} MON`
      );
    }
  }

  if (command === "!balance") {
    if (!hasGiveMonRole) {
      await message.reply("You aren't allowed to use this command.");
      return;
    }
    try {
      const balance = await provider.getBalance(CONTRACT_ADDRESS);
      const formattedBalance = ethers.formatEther(balance);
      await message.reply(`Contract balance: ${formattedBalance} MON`);
    } catch (error: any) {
      console.error("Error while retrieving contract balance:", error);
      await message.reply(
        "An error occurred while retrieving the contract balance."
      );
    }
  }
});

client.login(DISCORD_TOKEN);
