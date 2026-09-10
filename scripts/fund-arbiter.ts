import 'dotenv/config';
import { createWalletClient, createPublicClient, http, defineChain, parseEther, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const rpc = process.env.HEDERA_JSON_RPC || 'https://testnet.hashio.io/api';
const chain = defineChain({
  id: 296,
  name: 'Hedera Testnet',
  nativeCurrency: { name: 'HBAR', symbol: 'HBAR', decimals: 18 },
  rpcUrls: { default: { http: [rpc] } },
});

const opKey = process.env.OPERATOR_PRIVATE_KEY!;
const key = (opKey.startsWith('0x') ? opKey : `0x${opKey}`) as `0x${string}`;
const account = privateKeyToAccount(key);
const to = getAddress(process.env.ARBITER_ADDRESS!);

const wallet = createWalletClient({ account, chain, transport: http() });
const pub = createPublicClient({ chain, transport: http() });

console.log('from', account.address, 'to', to);
const before = await pub.getBalance({ address: to });
console.log('arbiter before', before.toString());

const hash = await wallet.sendTransaction({
  to,
  value: parseEther('5'),
  account,
  chain,
});
console.log('tx', hash);
const rcpt = await pub.waitForTransactionReceipt({ hash });
console.log('status', rcpt.status);
console.log('arbiter after', (await pub.getBalance({ address: to })).toString());
