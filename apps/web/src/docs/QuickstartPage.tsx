import { useState } from "react";
import { st } from "../lib/css";
import { useCopy } from "../lib/api";
import { Link } from "react-router-dom";

const PMS: [string, string][] = [["pnpm", "pnpm add @noux/gateway"], ["npm", "npm install @noux/gateway"], ["bun", "bun add @noux/gateway"]];
const OPTS = [
  { name: "campaign", req: true, type: "string", desc: "Campaign address. The claim must name this campaign." },
  { name: "price", req: true, type: "string", desc: "Price in USDC. A claim must carry exactly this price or it is refused." },
  { name: "network", req: true, type: '"solana-devnet"', desc: "Cluster. Claims are signed for one program and one cluster." },
  { name: "merchant", req: true, type: "Signer", desc: "Opens sale vaults and settles after delivery. KMS signers work too." },
  { name: "onPlainPurchase", req: false, type: "function", desc: "Called when a buyer pays without a valid claim. You keep 100%." },
];
const TOC: [string, string, boolean][] = [["before", "Before you start", false], ["install", "1. Install the gateway", false], ["campaign", "2. Create a campaign", false], ["gateway", "3. Put the gateway in front", false], ["options", "Options", true], ["keeper", "4. Run the keeper", false], ["test", "5. Make a test purchase", false]];

const H2 = "font-size: 24px; line-height: 30px; letter-spacing: -0.02em; font-weight: 500; color: #111111; margin-top: 16px;";
const FIG = "margin: 0; border: 1px solid #EBEBEB; border-radius: 12px; overflow: hidden;";
const PRE = "margin: 0; padding: 16px 20px; font-size: 13px; line-height: 22px; color: #111111; overflow-x: auto;";
const G = st("color: #6B6B6B;");
const OKC = st("color: #0E7A2F;");
const KW = st("color: #0058B0;");
const STR = st("color: #8A4B00;");
const HL = "display: block; padding: 0 20px 0 18px; background: #F0FDFA; border-left: 2px solid #0F766E;";


export const QUICKSTART_TOC = TOC;

export default function QuickstartPage() {
  const [pm, setPm] = useState("pnpm");
  const [copied, copy] = useCopy();
  return (
          <div style={st("display: flex; flex-direction: column; gap: 24px; font-size: 16px; line-height: 26px;")}>
            <p style={st("font-size: 18px; line-height: 28px; color: #333333; text-wrap: pretty;")}>Put a referral campaign in front of a paid x402 endpoint. You’ll add the gateway, create a campaign, run the keeper and make a test purchase. About fifteen minutes.</p>

            <div role="note" style={st("display: flex; gap: 12px; padding: 14px 16px; border: 1px solid #B3D4FF; background: rgba(0,88,176,0.05); border-radius: 12px;")}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#0058B0" strokeWidth="1.5" aria-hidden="true" style={st("flex: none; margin-top: 4px;")}><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg>
              <p style={st("font-size: 14px; line-height: 22px; color: #333333;")}><span style={st("font-weight: 500; color: #0058B0;")}>Note</span> · Noux runs on Solana devnet today. Use devnet USDC <code className="i">4zMM…DncDU</code>; nothing here moves real money. The commands below show the intended names: the <code className="i">@noux/gateway</code> package and the <code className="i">npx noux</code> CLI are not published yet.</p>
            </div>

            <h2 id="before" style={st(H2)}>Before you start</h2>
            <ul style={st("margin: 0; padding-left: 20px; color: #333333; display: flex; flex-direction: column; gap: 6px;")}>
              <li>A paid route that already answers x402 on Solana, or a fresh Express app</li>
              <li>A merchant wallet with a little devnet SOL and devnet USDC for the commission budget</li>
              <li>Node 20 or newer</li>
            </ul>

            <h2 id="install" style={st(H2)}>1. Install the gateway</h2>
            <figure style={st(FIG)}>
              <figcaption style={st("height: 40px; display: flex; align-items: center; gap: 4px; padding: 0 6px 0 8px; border-bottom: 1px solid #EBEBEB; background: #FAFAFA;")}>
                <div role="tablist" aria-label="Package manager" style={st("display: flex; gap: 2px;")}>
                  {PMS.map(([p]) => {
                    const on = pm === p;
                    return <button key={p} className="press" type="button" role="tab" aria-selected={on} onClick={() => setPm(p)} style={st('height: 28px; padding: 0 10px; border: 0; border-radius: 8px; font: 500 12px "Geist Mono", monospace; cursor: pointer; ' + (on ? "background: #FFFFFF; color: #111111; box-shadow: 0 0 0 1px rgb(0 0 0 / .08);" : "background: transparent; color: #6B6B6B;"))}>{p}</button>;
                  })}
                </div>
                <span style={{ flex: 1 }} />
                <button className="press bs" type="button" aria-label="Copy command" onClick={() => copy("i", PMS.find((x) => x[0] === pm)![1])} style={st("height: 28px; padding: 0 10px; border: 0; background: transparent; border-radius: 8px; font: 500 12px Inter, sans-serif; color: #333333; cursor: pointer;")}>{copied === "i" ? "Copied" : "Copy"}</button>
              </figcaption>
              <pre className="mono" style={st(PRE)}><span style={G}>$ </span>{PMS.find((x) => x[0] === pm)![1]}</pre>
            </figure>

            <h2 id="campaign" style={st(H2)}>2. Create a campaign</h2>
            <p style={st("color: #333333;")}>A campaign sets your terms on-chain. Commission is at most 50% and the hold at most 600 seconds. The protocol fee is set by the program (at most 5%) and copied into your campaign when you create it; you can’t change it or point it at your own wallet. The commission budget is a cap on what you can pay out in commission, not money held in escrow. You can also do this from the <Link to="/app/merchant">merchant console</Link>.</p>
            <figure style={st(FIG)}>
              <figcaption style={st("height: 40px; display: flex; align-items: center; padding: 0 16px; border-bottom: 1px solid #EBEBEB; background: #FAFAFA;")}><span className="mono" style={st("font-size: 12px; color: #111111;")}>Terminal</span></figcaption>
              <pre className="mono" style={st(PRE)}>
                <span style={G}>$ </span>{"npx noux campaign create \\\n    --commission 15 \\\n    --budget 50 \\\n    --hold 120 \\\n    --keypair ./merchant.json\n\n"}
                <span style={OKC}>✓</span>{" Campaign B7DSpwzF…WBWT created\n"}
                <span style={OKC}>✓</span>{" Commission budget set · 50.000000 USDC cap (not escrowed)"}
              </pre>
            </figure>

            <h2 id="gateway" style={st(H2)}>3. Put the gateway in front of your route</h2>
            <p style={st("color: #333333;")}>The gateway checks the buyer’s claim, opens a per-sale vault and answers <code className="i">402</code> with that vault as <code className="i">payTo</code>. With no claim, it falls back to a plain purchase paid straight to you.</p>
            <figure style={st(FIG)}>
              <figcaption style={st("height: 40px; display: flex; align-items: center; padding: 0 6px 0 16px; border-bottom: 1px solid #EBEBEB; background: #FAFAFA;")}>
                <span className="mono" style={st("font-size: 12px; color: #111111;")}>server.ts</span><span style={{ flex: 1 }} />
                <button className="press bs" type="button" aria-label="Copy code" onClick={() => copy("code", 'import { nouxGateway } from "@noux/gateway";\n\napp.use("/v1/brief", nouxGateway({\n  campaign: process.env.NOUX_CAMPAIGN,\n  price: "0.10",\n  network: "solana-devnet",\n  merchant: loadKeypair("./merchant.json"),\n}));\n\napp.get("/v1/brief", async (c) => c.json(await brief()));')} style={st("height: 28px; padding: 0 10px; border: 0; background: transparent; border-radius: 8px; font: 500 12px Inter, sans-serif; color: #333333; cursor: pointer;")}>{copied === "code" ? "Copied" : "Copy"}</button>
              </figcaption>
              <pre className="mono" style={st("margin: 0; padding: 16px 0; font-size: 13px; line-height: 22px; color: #333333; overflow-x: auto;")}>
                <span style={st("display: block; padding: 0 20px;")}><span style={KW}>import</span>{" { nouxGateway } "}<span style={KW}>from</span> <span style={STR}>"@noux/gateway"</span>;</span>
                <span style={st("display: block; padding: 0 20px;")}>{" "}</span>
                <span style={st(HL)}>{"app.use("}<span style={STR}>"/v1/brief"</span>{", nouxGateway({"}</span>
                <span style={st(HL)}>{"  campaign: process.env.NOUX_CAMPAIGN,"}</span>
                <span style={st(HL)}>{"  price: "}<span style={STR}>"0.10"</span>,</span>
                <span style={st(HL)}>{"  network: "}<span style={STR}>"solana-devnet"</span>,</span>
                <span style={st(HL)}>{"  merchant: loadKeypair("}<span style={STR}>"./merchant.json"</span>{"),"}</span>
                <span style={st(HL)}>{"}));"}</span>
                <span style={st("display: block; padding: 0 20px;")}>{" "}</span>
                <span style={st("display: block; padding: 0 20px;")}>{"app.get("}<span style={STR}>"/v1/brief"</span>{", async (c) => c.json("}<span style={KW}>await</span>{" brief()));"}</span>
              </pre>
            </figure>

            <h3 id="options" style={st("font-size: 16px; line-height: 20px; letter-spacing: -0.01em; font-weight: 500; color: #111111; margin-top: 8px;")}>Options</h3>
            <div style={st("border: 1px solid #EBEBEB; border-radius: 12px; overflow-x: auto;")}>
              <table style={st("width: 100%; min-width: 560px; border-collapse: collapse; font-size: 14px; line-height: 20px;")}>
                <thead><tr style={st("text-align: left; height: 40px;")}>{["Name", "Type", "Description"].map((h) => <th key={h} scope="col" style={st("padding: 0 16px; font-size: 12px; font-weight: 500; color: #6B6B6B; border-bottom: 1px solid #EBEBEB;")}>{h}</th>)}</tr></thead>
                <tbody>
                  {OPTS.map((o) => (
                    <tr key={o.name}>
                      <td style={st("padding: 12px 16px; border-bottom: 1px solid #EBEBEB; vertical-align: top; white-space: nowrap;")}><span className="mono" style={st("font-size: 13px; color: #111111;")}>{o.name}</span>{o.req && <span style={st("margin-left: 6px; height: 18px; padding: 0 6px; border-radius: 6px; background: #F4F4F5; color: #333333; font-size: 11px; font-weight: 500; display: inline-flex; align-items: center;")}>Required</span>}</td>
                      <td className="mono" style={st("padding: 12px 16px; border-bottom: 1px solid #EBEBEB; vertical-align: top; font-size: 12px; color: #6B6B6B; white-space: nowrap;")}>{o.type}</td>
                      <td style={st("padding: 12px 16px; border-bottom: 1px solid #EBEBEB; color: #333333;")}>{o.desc}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h2 id="keeper" style={st(H2)}>4. Run the keeper</h2>
            <p style={st("color: #333333;")}>You can settle each sale yourself right after you deliver. The keeper is a backstop: it settles funded sales once the hold has passed and closes unpaid ones after their claim expires. Anyone can run it.</p>
            <figure style={st(FIG)}><pre className="mono" style={st(PRE)}><span style={G}>$ </span>npx noux keeper --campaign $NOUX_CAMPAIGN</pre></figure>

            <div role="note" style={st("display: flex; gap: 12px; padding: 14px 16px; border: 1px solid #F5D9A8; background: rgba(138,75,0,0.05); border-radius: 12px;")}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#8A4B00" strokeWidth="1.5" aria-hidden="true" style={st("flex: none; margin-top: 4px;")}><path d="M12 3 2 20h20L12 3Z" /><path d="M12 10v4M12 17h.01" /></svg>
              <p style={st("font-size: 14px; line-height: 22px; color: #333333;")}><span style={st("font-weight: 500; color: #8A4B00;")}>Warning</span> · Price and payer checks happen in the gateway, not on-chain. If you serve a paid route without the gateway, those protections don’t apply. Attribution and the split still follow the on-chain terms.</p>
            </div>

            <h2 id="test" style={st(H2)}>5. Make a test purchase</h2>
            <p style={st("color: #333333;")}>The test buyer asks for a claim, calls your route and pays. When the hold ends you’ll have a public receipt.</p>
            <figure style={st(FIG)}>
              <pre className="mono" style={st(PRE)}>
                <span style={G}>$ </span>{"npx noux buy https://your-api.dev/v1/brief --ref 9fQe…Lm3a\n\n"}
                <span style={G}>{"claim     "}</span>{"issued, expires in 10:00\n"}
                <span style={G}>{"402       "}</span>{"payTo 3hVd…p8Rk (sale vault)\n"}
                <span style={G}>{"paid      "}</span>{"0.100000 USDC\n"}
                <span style={OKC}>{"200       "}</span>{"resource served\n"}
                <span style={G}>{"receipt   "}</span>{"https://noux.so/r/4tQm…Zk2P"}
              </pre>
            </figure>

          </div>
  );
}
