  const express = require('express');
  const fetch = require('node-fetch');
  const { ethers } = require('ethers');
  const app = express();
  app.use(express.json());

  // simple in-memory rate limit map (production: use redis)
  const rateMap = new Map();

  app.post('/api/chat', async (req,res) =>{
    try{
      const { address, signature, input, context } = req.body;
      // verify signature if present
      if(signature){
        const recovered = ethers.utils.verifyMessage('I am requesting an AI response: ' + input, signature);
        if(recovered.toLowerCase() !== address.toLowerCase()){
          return res.status(401).json({ error: 'signature mismatch' });
        }
      }

      // OPTIONAL: server-side ownership check here using ethers provider and RPC
      // e.g. use provider.getSigner / contract.ownerOf to verify nft ownership

      // forward to OpenAI (example using Chat Completions)
      const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
      if(!OPENAI_API_KEY) return res.status(500).json({ error: 'Server misconfigured: missing OPENAI_API_KEY' });

      const prompt = `User address: ${address}\nContext: ${JSON.stringify(context)}\nUser: ${input}`;
      const payload = {
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You are an NFT-aware assistant. Keep responses short (2-3 sentences) on mobile.' },
          { role: 'user', content: prompt }
        ],
        max_tokens: 400
      };

      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENAI_API_KEY}`
        },
        body: JSON.stringify(payload)
      });
res.setHeader('Content-Type', 'text/plain; charset=utf-8');
res.setHeader('Transfer-Encoding', 'chunked');

const payload = {
  model: 'gpt-4o-mini',
  stream: true,
  messages: [
    { role: 'system', content: 'You are an NFT-aware assistant. Keep responses short and conversational.' },
    { role: 'user', content: prompt }
  ],
  max_tokens: 400
};

const openaiResp = await fetch('https://api.openai.com/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${OPENAI_API_KEY}`
  },
  body: JSON.stringify(payload)
});

// Relay the streaming data chunk-by-chunk
for await (const chunk of openaiResp.body) {
  res.write(chunk);
}
res.end();
    }catch(err){
      console.error(err); res.status(500).json({ error: 'server error' });
    }
  });

  const port = process.env.PORT || 3000; app.listen(port, ()=> console.log('listening',port));
