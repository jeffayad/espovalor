ValorPay Espo viewer - no maxSize version.

This version calls /api/v1/CValorTerminal exactly, without ?maxSize=500.

Setup:
1. Rename .env.example to .env
2. Paste your ESPO_API_KEY
3. Run:
   npm install
   npm start
4. Open:
   http://localhost:3005/?accountId=6a1276fd9b32738f3
