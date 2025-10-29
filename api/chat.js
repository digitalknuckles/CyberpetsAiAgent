// /api/chat.js
import fetch from 'node-fetch';
import { ethers } from 'ethers';

const ALLOWED_DEFAULT = [
  'https://cyberpetsreboot.xyz',
  'https://digitalknuckles.github.io',
  'http://localhost:3000'
];

export default async function handler(req, res) {
  // ---------- CORS ----------
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || ALLOWED_DEFAULT.join(',')).split(',');
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  // allow credentials if you rely on cookies / sessions:
  // res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // ---------- Basic checks ----------
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { address, signature, input, context } = req.body || {};
  if (!address || !signature || !input) {
    return res.status(400).json({ error: 'Missing required fields: address, signature, input' });
  }

  // ---------- ENV checks ----------
  if (!process.env.OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY missing');
    return res.status(500).json({ error: 'Server misconfigured (missing OPENAI_API_KEY)' });
  }
  const RPC_URL = process.env.RPC_URL || 'https://cloudflare-eth.com';
  if (!RPC_URL) {
    return res.status(500).json({ error: 'Server misconfigured (missing RPC_URL)' });
  }

  // ---------- Verify signature (anti-spoof) ----------
  try {
    // The client signs: 'I am requesting an AI response: ' + input
    const expectedMessage = 'I am requesting an AI response: ' + input;
    const recovered = ethers.utils.verifyMessage(expectedMessage, signature);
    if (recovered.toLowerCase() !== address.toLowerCase()) {
      return res.status(401).json({ error: 'Signature does not match address' });
    }
  } catch (err) {
    console.error('signature verify failed', err);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  // ---------- On-chain ownership check ----------
  // CONFIG from client: { nft_contract, nft_token_id }  (client provided context)
  // We will check either:
  //  - If nft_token_id is provided -> ownerOf(tokenId) must equal address
  //  - Else -> balanceOf(address) > 0
  const nftContract = (context && context.nft_contract) || null;
  const nftTokenId = (context && context.nft_token_id) ?? null;

  if (!nftContract) {
    return res.status(400).json({ error: 'Missing nft_contract in context' });
  }

  try {
    const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
    const ERC721_ABI = [
      'function ownerOf(uint256) view returns (address)',
      'function balanceOf(address) view returns (uint256)',
      'function tokenOfOwnerByIndex(address,uint256) view returns (uint256)'
    ];
    const contract = new ethers.Contract(nftContract, ERC721_ABI, provider);

    let owns = false;
    if (nftTokenId !== null && nftTokenId !== undefined) {
      try {
        const owner = await contract.ownerOf(nftTokenId);
        if (owner && owner.toLowerCase() === address.toLowerCase()) owns = true;
      } catch (err) {
        // ownerOf may revert (nonexistent token) — fall back to balanceOf
        console.warn('ownerOf check failed, falling back to balanceOf', err?.message || err);
      }
    }
    if (!owns) {
      try {
        const bal = await contract.balanceOf(address);
        if (bal && bal.toNumber && bal.toNumber() > 0) owns = true;
      } catch (err) {
        console.warn('balanceOf check failed', err?.message || err);
        // Can't verify ownership: reject to be safe.
      }
    }
    if (!owns) {
      return res.status(403).json({ error: 'NFT ownership check failed - access denied' });
    }
  } catch (err) {
    console.error('ownership verification error', err);
    return res.status(500).json({ error: 'Failed to verify ownership' });
  }

  // ---------- Proxy to OpenAI with streaming ----------
  // This implementation forwards the OpenAI streaming chunked response to the client.
  // We use SSE-ish passthrough: set headers and write data as chunks arrive.
  try {
    // Prepare openai request body — adjust model and params as needed
    const openaiBody = {
      model: 'gpt-4o-mini', // choose model you have access to, or change to 'gpt-4o'/'gpt-4' etc.
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: input }
      ],
      stream: true
    };

    // Call OpenAI
    const oaResp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(openaiBody),
    });

    if (!oaResp.ok || !oaResp.body) {
      // read as text for debugging
      const text = await oaResp.text().catch(()=>'<no-body>');
      console.error('OpenAI responded with error', oaResp.status, text);
      return res.status(500).json({ error: 'OpenAI request failed', status: oaResp.status, body: text });
    }

    // Tell client this is a stream we will push as received
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');

    // Pipe chunks from OpenAI to client as-is (SSE data lines)
    const reader = oaResp.body.getReader();
    const decoder = new TextDecoder();

    // Helper to write; keep socket alive
    const write = (chunk) => {
      try {
        res.write(chunk);
      } catch (err) {
        console.warn('res.write failed', err);
      }
    };

    // async read loop
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunkText = decoder.decode(value);
      // OpenAI provides SSE 'data: {...}\n\n' style chunks — forward them
      write(chunkText);
    }

    // finish stream
    // Some clients expect a final event; send a termination marker
    res.write('\n\n'); // ensures closure
    return res.end();
  } catch (err) {
    console.error('streaming error', err);
    try { res.status(500).json({ error: 'Internal server error' }); } catch(e) {}
    return;
  }
}
