import { vastaiSearchOffers } from './lib/vastai.js';

async function main() {
  const searchParams = {
    limit: 500,
    type: "on-demand",
    allocated_storage: 100,

    rentable: { eq: true },
    rented: { eq: false },
    verified: { eq: true },

    num_gpus: { eq: 1 },
    cpu_ram: { gt: 60000 }
    gpu_ram: { gt: 20000 }
  };

  const offers = await vastaiSearchOffers(searchParams);

  console.log("Found offers:", offers.length);

  for (const o of offers.slice(0, 50)) {
    console.log(
      `${o.gpu_name} x${o.num_gpus} | DPH: $${o.dph_total.toFixed(2)}/h  | Storage: $${(o.storage_total_cost * 24 * 30).toFixed(2)}/month | rel=${o.reliability.toFixed(2)}`
    );
  }

}

main();
