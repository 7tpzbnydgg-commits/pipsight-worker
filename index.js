import ws from 'ws';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
  {
    realtime: {
      transport: ws
    
    }
  }
);

async function updatePrices() {
  const apiKey = process.env.TWELVE_DATA_API_KEY;

  const res = await fetch(
    `https://api.twelvedata.com/price?symbol=XAU/USD&apikey=${apiKey}`
  );

  const data = await res.json();

  console.log(data);

  if (data.price) {
    const { error } = await supabase
      .from('prices')
      .insert({
        symbol: 'XAUUSD',
        price: parseFloat(data.price),
        source: 'twelvedata'
      });

    console.log('Insert error:', error);
    console.log('Price updated:', data.price);
  }
}

updatePrices();
