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

const allowedChannelIds: string[] = ["1343914711460347945"];

const allowedGiveMonRoleIds: string[] = [
  "1202897827232219176",
  "1260311106992476331",
  "1218983061014839346",
];

let totalSent: bigint = ethers.parseEther("0");
const MAX_SENT: bigint = ethers.parseEther("1");

const isValidAddress = (address: string): boolean => {
  try {
    ethers.getAddress(address);
    return true;
  } catch {
    return false;
  }
};

client.on("messageCreate", async (message: Message) => {
  if (message.author.bot) return;
  if (!allowedChannelIds.includes(message.channel.id)) return;

  const args = message.content.split(" ");
  const command = args[0];

  if (command === "!faucet") {
    if (args.length < 2) {
      await message.react("❌");
      return;
    }
    const userEthAddress = args[1];
    if (!isValidAddress(userEthAddress)) {
      await message.react("❌");
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

    const faucetAmount: bigint = ethers.parseEther("0.2");
    if (totalSent + faucetAmount > MAX_SENT) {
      await message.reply(
        "Faucet reached his daily limit. No more tokens can be sent."
      );
      return;
    }

    try {
      const nonce = await provider.getTransactionCount(
        wallet.address,
        "pending"
      );
      const tx = await faucetContract.faucet(userEthAddress, { nonce });
      await tx.wait();
      claimCooldown.set(userId, now);
      totalSent += faucetAmount;
      await message.react("✅");
    } catch (error: any) {
      console.error("Error while calling faucet:", error);
      await message.react("❌");
    }
  }

  if (command === "!give-mon") {
    await message.member?.fetch();
    if (
      !message.member?.roles.cache.some((role) =>
        allowedGiveMonRoleIds.includes(role.id)
      )
    ) {
      await message.react("❌");
      return;
    }
    if (args.length < 3) {
      await message.react("❌");
      return;
    }
    const targetAddress = args[1];
    const amountInput = args[2];
    if (!isValidAddress(targetAddress)) {
      await message.react("❌");
      return;
    }
    let amount: bigint;
    try {
      amount = ethers.parseUnits(amountInput, 18);
    } catch (error: any) {
      await message.react("❌");
      return;
    }
    if (totalSent + amount > MAX_SENT) {
      await message.reply(
        "Faucet reached his daily limit. No more tokens can be sent."
      );
      return;
    }
    try {
      const nonce = await provider.getTransactionCount(
        wallet.address,
        "pending"
      );
      const tx = await faucetContract.giveMon(targetAddress, amount, { nonce });
      await tx.wait();
      totalSent += amount;
      await message.react("✅");
    } catch (error: any) {
      console.error("Error while calling giveMon:", error);
      await message.react("❌");
    }
  }

  if (command === "!daily") {
    if (
      !message.member?.roles.cache.some((role) =>
        allowedGiveMonRoleIds.includes(role.id)
      )
    ) {
      await message.react("❌");
      return;
    }
    const remaining: bigint = MAX_SENT - totalSent;
    if (remaining <= ethers.parseEther("0")) {
      await message.reply("Faucet reached his daily limit.");
    } else {
      const formattedRemaining = ethers.formatEther(remaining);
      await message.reply(
        `Remaining tokens for today: ${formattedRemaining} MON`
      );
    }
  }

  if (command === "!balance") {
    if (
      !message.member?.roles.cache.some((role) =>
        allowedGiveMonRoleIds.includes(role.id)
      )
    ) {
      await message.react("❌");
      return;
    }
    try {
      const balance = await provider.getBalance(CONTRACT_ADDRESS);
      const formattedBalance = ethers.formatEther(balance);
      await message.reply(`Contract balance: ${formattedBalance} MON`);
    } catch (error: any) {
      console.error("Error while retrieving contract balance:", error);
      await message.react("❌");
    }
  }
});

client.login(DISCORD_TOKEN);
