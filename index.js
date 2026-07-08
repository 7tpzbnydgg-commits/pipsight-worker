import { createClient } from '@supabase/supabase-js';

console.log('URL:', process.env.SUPABASE_URL);
console.log('KEY EXISTS:', !!process.env.SUPABASE_ANON_KEY);
console.log('TWELVE EXISTS:', !!process.env.TWELVE_DATA_API_KEY);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

async function updatePrices() {
  const apiKey = process.env.TWELVE_DATA_API_KEY;

  const res = await fetch(
    `https://api.twelvedata.com/price?symbol=XAU/USD&apikey=${apiKey}`
  );

  const data = await res.json();

  if (data.price) {
    await supabase
      .from('prices')
      .insert({
        symbol: 'XAUUSD',
        price: parseFloat(data.price),
        source: 'twelvedata'
      });

    console.log('Price updated:', data.price);
  } else {
    console.log(data);
  }
}

updatePrices();
