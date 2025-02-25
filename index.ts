import {
  Client,
  GatewayIntentBits,
  Message,
  PermissionsBitField,
} from "discord.js";
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
    try {
      const tx = await faucetContract.faucet(userEthAddress);
      await tx.wait();
      await message.react("✅");
    } catch (error: any) {
      console.error("Error while calling faucet:", error);
      await message.react("❌");
    }
  }

  if (command === "!give-mon") {
    if (
      !message.member?.permissions.has(PermissionsBitField.Flags.Administrator)
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
    let amount;
    try {
      amount = ethers.parseUnits(amountInput, 18);
    } catch (error: any) {
      await message.react("❌");
      return;
    }
    try {
      const tx = await faucetContract.giveMon(targetAddress, amount);
      await tx.wait();
      await message.react("✅");
    } catch (error: any) {
      console.error("Error while calling giveMon:", error);
      await message.react("❌");
    }
  }
});

client.login(DISCORD_TOKEN);
