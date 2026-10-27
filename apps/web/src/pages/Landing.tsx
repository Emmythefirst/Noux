import { useState } from "react";
import { Link } from "react-router-dom";
import { st } from "../lib/css";
import { useApi, useCopy, type Page as ApiPage, type Campaign, type Stats } from "../lib/api";
import { CATEGORIES, bpsPct, fmtAmount } from "../lib/format";
import { Page, TopNav, SiteFooter, SampleBadge } from "../components/common";

const INSTALL = "pnpm add @noux/gateway";
const H2 = "font-size: clamp(2rem, 1.4rem + 2vw, 2.75rem); line-height: 1.05; letter-spacing: -0.03em; font-weight: 500; color: #111111; text-wrap: balance;";
const SECTION = "max-width: 1280px; margin: 0 auto; padding: 128px clamp(16px, 4vw, 48px) 0;";
const CARD_SHADOW = "box-shadow: 0 0 0 1px rgb(0 0 0 / .06), 0 1px 2px -1px rgb(0 0 0 / .06), 0 2px 4px 0 rgb(0 0 0 / .04);";

/** A real devnet sale (0.10 USDC, 15% commission, 1% fee). The hero shows its exact numbers and links to its public receipt. */
const HERO_SALE = { address: "AjpAUxR7X5HPGaKdRaFZ9CwSumPZ5pt1gxkp6EjfcKFx", short: "AjpA…cKFx", distributor: "A84G…ZxUo" };

const PRICES = [30000, 100000, 1000000, 5000000];
const PRICE_LABELS = ["0.03 USDC", "0.10 USDC", "1.00 USDC", "5.00 USDC"];
const FEE_BPS = 100;

function Simulator() {
  const [price, setPrice] = useState(100000);
  const [comm, setComm] = useState(15);
  // The program's rule: fee and commission are floored, the merchant gets the remainder.
  const fee = Math.floor((price * FEE_BPS) / 10000);
  const c = Math.floor((price * comm * 100) / 10000);
  const m = price - fee - c;
  const f = (n: number) => fmtAmount(String(n));
  return (
    <div style={st("background: #FAFAFA; border: 1px solid #EBEBEB; border-radius: 24px; padding: 28px; display: flex; flex-direction: column; gap: 24px;")}>
      <div style={st("display: grid; grid-template-columns: repeat(auto-fit, minmax(min(200px, 100%), 1fr)); gap: 20px;")}>
        <div style={st("display: flex; flex-direction: column; gap: 8px;")}>
          <span id="price-l" style={st("font-size: 13px; font-weight: 500; color: #333333;")}>Price per call</span>
          <div role="radiogroup" aria-labelledby="price-l" style={st("display: flex; gap: 6px; flex-wrap: wrap;")}>
            {PRICES.map((v, i) => {
              const on = v === price;
              return (
                <button key={v} className="press" type="button" role="radio" aria-checked={on} onClick={() => setPrice(v)}
                  style={st("height: 32px; padding: 0 12px; border-radius: 9999px; font: 500 13px Inter, sans-serif; cursor: pointer; font-variant-numeric: tabular-nums; " + (on ? "background: #111111; color: #FFFFFF; border: 1px solid #111111;" : "background: #FFFFFF; color: #333333; border: 1px solid #EBEBEB;"))}>
                  {PRICE_LABELS[i]}
                </button>
              );
            })}
          </div>
        </div>
        <div style={st("display: flex; flex-direction: column; gap: 8px;")}>
          <label htmlFor="comm" style={st("font-size: 13px; font-weight: 500; color: #333333; display: flex; justify-content: space-between;")}>
            <span>Commission</span><span className="tn" style={st("color: #0F766E;")}>{comm}%</span>
          </label>
          <input id="comm" type="range" min={0} max={50} step={1} value={comm} onChange={(e) => setComm(Number(e.target.value))} style={st("width: 100%; height: 28px;")} />
          <span style={st("font-size: 12px; color: #6B6B6B;")}>Up to 50%. Protocol fee in this example: 1%.</span>
        </div>
      </div>
      <div style={st("display: flex; gap: 4px; height: 44px;")} aria-hidden="true">
        <div className="seg-live" style={{ ...st("flex-basis: 0; min-width: 0; background: #111111; border-radius: 8px 4px 4px 8px;"), flexGrow: Math.max(m, 1) }} />
        <div className="seg-live" style={{ ...st("flex-basis: 0; min-width: 4px; background: #0F766E; border-radius: 4px;"), flexGrow: Math.max(c, 0) }} />
        <div style={st("flex: 0 0 8px; background: #D4D4D8; border-radius: 4px 8px 8px 4px;")} />
      </div>
      <dl className="tn" style={st("margin: 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px;")}>
        {[
          ["Merchant", "#111111", "#111111", f(m)],
          ["Distributor", "#0F766E", "#0F766E", f(c)],
          ["Protocol fee", "#D4D4D8", "#111111", f(fee)],
        ].map(([label, sw, fg, amt]) => (
          <div key={label} style={st("display: flex; flex-direction: column; gap: 4px;")}>
            <dt style={st("font-size: 12px; color: #6B6B6B; display: flex; align-items: center; gap: 6px;")}><span aria-hidden="true" style={{ ...st("width: 10px; height: 6px; border-radius: 2px;"), background: sw }} />{label}</dt>
            <dd style={{ ...st("margin: 0; font-size: 18px; font-weight: 500; letter-spacing: -0.01em;"), color: fg }}>{amt}</dd>
          </div>
        ))}
      </dl>
      <p className="mono tn" role="status" style={st("font-size: 12px; color: #6B6B6B; border-top: 1px dashed #D4D4D8; padding-top: 14px; overflow-wrap: anywhere;")}>
        {f(m)} + {f(c)} + {f(fee)} = {f(price)} USDC  ✓ exact
      </p>
    </div>
  );
}

function Tag({ children, green = false }: { children: string; green?: boolean }) {
  return <span className="mono" style={st("font-size: 11px; border-radius: 6px; padding: 3px 6px; " + (green ? "color: #0E7A2F; background: #CAFACE;" : "color: #333333; border: 1px solid #EBEBEB;"))}>{children}</span>;
}

export default function Landing() {
  const [copied, copy] = useCopy();
  const camps = useApi<ApiPage<Campaign>>("/campaigns?limit=3&sort=newest");
  const stats = useApi<Stats>("/stats");

  return (
    <Page>
      <a href="#main" className="skip">Skip to content</a>
      <TopNav variant="landing" />
      <main id="main" tabIndex={-1}>
        {/* HERO */}
        <section style={st("max-width: 1280px; margin: 0 auto; padding: clamp(56px, 8vw, 112px) clamp(16px, 4vw, 48px) 96px; display: grid; grid-template-columns: repeat(auto-fit, minmax(min(480px, 100%), 1fr)); gap: 64px; align-items: center;")}>
          <div style={st("display: flex; flex-direction: column; gap: 28px;")}>
            <a className="hero-in" href="#math" style={st("align-self: flex-start; display: inline-flex; align-items: center; gap: 8px; height: 28px; padding: 0 12px 0 4px; border: 1px solid #EBEBEB; border-radius: 9999px; font-size: 13px; color: #333333;")}>
              <span style={st("background: #F4F4F5; border-radius: 9999px; padding: 2px 8px; font-size: 12px; font-weight: 500; color: #111111;")}>x402 on Solana</span>
              <span>Referral campaigns for paid APIs</span>
              <span aria-hidden="true" style={st("color: #6B6B6B;")}>→</span>
            </a>
            <h1 className="hero-in2" style={st("font-size: clamp(2.75rem, 1.6rem + 3.8vw, 4.5rem); line-height: 1; letter-spacing: -0.04em; font-weight: 500; color: #111111; text-wrap: balance;")}>
              Pay for buyers.<br /><span style={st("color: #6B6B6B;")}>Not for clicks.</span>
            </h1>
            <p className="hero-in3" style={st("font-size: 18px; line-height: 28px; letter-spacing: -0.01em; color: #333333; max-width: 520px; text-wrap: pretty;")}>
              Noux lets any paid x402 service run a referral campaign with a capped commission budget. When a person or an AI agent brings you a buyer who pays, the payment splits on-chain, and the sale leaves a public receipt anyone can check.
            </p>
            <div className="hero-in3" style={st("display: flex; flex-wrap: wrap; gap: 12px; align-items: center;")}>
              <Link className="press bi" to="/app/merchant" style={st("height: 44px; padding: 0 20px; border-radius: 9999px; background: #111111; color: #FFFFFF; font-size: 15px; font-weight: 500; letter-spacing: -0.01em; display: inline-flex; align-items: center;")}>Create campaign</Link>
              <Link className="press bs" to="/campaigns" style={st("height: 44px; padding: 0 20px; border-radius: 9999px; background: #FFFFFF; color: #111111; border: 1px solid #D4D4D8; font-size: 15px; font-weight: 500; letter-spacing: -0.01em; display: inline-flex; align-items: center;")}>Browse campaigns</Link>
            </div>
            <div className="hero-in3" style={st("display: flex; align-items: center; gap: 12px; height: 44px; padding: 0 6px 0 16px; background: #FAFAFA; border: 1px solid #EBEBEB; border-radius: 12px; max-width: 420px;")}>
              <span className="mono" aria-hidden="true" style={st("font-size: 13px; color: #6B6B6B;")}>$</span>
              <code className="mono" style={st("font-size: 13px; color: #111111; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;")}>{INSTALL}</code>
              <button className="press bs" type="button" onClick={() => copy("i", INSTALL)} aria-label="Copy install command"
                style={st("height: 32px; padding: 0 12px; border: 1px solid #EBEBEB; background: #FFFFFF; border-radius: 8px; font: 500 12px Inter, sans-serif; color: #333333; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;")}>
                {copied === "i" ? (
                  <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#0F766E" strokeWidth="2" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg><span style={st("color: #0F766E;")}>Copied</span></>
                ) : (
                  <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg><span>Copy</span></>
                )}
              </button>
            </div>
          </div>

          {/* Hero receipt: the loud idea */}
          <div className="card-in" style={st("position: relative;")}>
            <div aria-hidden="true" style={st("position: absolute; inset: 24px -12px -24px 24px; border-radius: 24px; background: #F4F4F5;")} />
            <article aria-label="Example receipt: one payment split three ways" style={st("position: relative; background: #FFFFFF; border-radius: 24px; box-shadow: 0 0 0 1px rgb(0 0 0 / .06), 0 1px 1px -.5px rgb(0 0 0 / .06), 0 3px 3px -1.5px rgb(0 0 0 / .06), 0 6px 6px -3px rgb(0 0 0 / .06), 0 12px 12px -6px rgb(0 0 0 / .06), 0 24px 24px -12px rgb(0 0 0 / .06); padding: 28px; display: flex; flex-direction: column; gap: 24px;")}>
              <div style={st("display: flex; align-items: center; gap: 8px; flex-wrap: wrap;")}>
                <span style={st("font-size: 13px; font-weight: 500; color: #111111;")}>Receipt</span>
                <span className="mono" style={st("font-size: 12px; color: #6B6B6B;")}>{HERO_SALE.short}</span>
                <span style={{ flex: 1 }} />
                <SampleBadge />
                <span style={st("height: 20px; padding: 0 8px; border-radius: 6px; background: #CAFACE; color: #0E7A2F; font-size: 12px; font-weight: 500; display: inline-flex; align-items: center; gap: 6px;")}><span aria-hidden="true" style={st("width: 6px; height: 6px; border-radius: 9999px; background: #15B042;")} />Settled</span>
              </div>
              <div style={st("display: flex; flex-direction: column; gap: 4px;")}>
                <span style={st("font-size: 13px; color: #6B6B6B;")}>Buyer paid · Noux sample service · devnet</span>
                <div className="tn" style={st("display: flex; align-items: baseline; gap: 8px;")}><span style={st("font-size: 44px; line-height: 46px; letter-spacing: -0.03em; font-weight: 500; color: #111111;")}>0.100000</span><span style={st("font-size: 18px; color: #6B6B6B;")}>USDC</span></div>
              </div>

              <div style={st("position: relative; height: 56px;")}>
                <div className="seg-in" style={st("display: flex; gap: 4px; height: 56px;")}>
                  <div style={st("flex: 84 1 0; min-width: 0; background: #111111; border-radius: 10px 4px 4px 10px; display: flex; align-items: center; padding: 0 14px; color: #FFFFFF; font-size: 13px; font-weight: 500;")}>Merchant · 84%</div>
                  <div style={st("flex: 15 1 0; min-width: 64px; background: #0F766E; border-radius: 4px; display: flex; align-items: center; justify-content: center; color: #FFFFFF; font-size: 13px; font-weight: 500;")}>15%</div>
                  <div style={st("flex: 1 1 0; min-width: 10px; background: #D4D4D8; border-radius: 4px 10px 10px 4px;")} />
                </div>
                <div className="unite" aria-hidden="true" style={st("position: absolute; inset: 0; background: #111111; border-radius: 10px;")} />
              </div>

              <dl style={st("margin: 0; display: flex; flex-direction: column;")}>
                {[
                  ["lab-in", "#111111", <>Merchant</>, "84.00%", "0.084000", "#111111", "border-bottom: 1px solid #EBEBEB;"],
                  ["lab-in2", "#0F766E", <>Distributor <span className="mono" style={st("font-size: 12px; color: #6B6B6B;")}>{HERO_SALE.distributor}</span></>, "15.00%", "0.015000", "#0F766E", "border-bottom: 1px solid #EBEBEB;"],
                  ["lab-in3", "#D4D4D8", <>Protocol fee</>, "1.00%", "0.001000", "#111111", ""],
                ].map(([cls, sw, name, pct, amt, color, border], i) => (
                  <div key={i} className={cls as string} style={st("display: grid; grid-template-columns: 14px 1fr auto auto; gap: 12px; align-items: center; height: 40px; " + border)}>
                    <span aria-hidden="true" style={{ ...st("width: 14px; height: 8px; border-radius: 2px;"), background: sw as string }} />
                    <dt style={st("font-size: 14px; color: #333333;")}>{name}</dt>
                    <dd className="tn" style={st("margin: 0; font-size: 13px; color: #6B6B6B;")}>{pct}</dd>
                    <dd className="tn" style={{ ...st("margin: 0; font-size: 14px; font-weight: 500; text-align: right; min-width: 120px;"), color: color as string }}>{amt} <span style={st("color: #6B6B6B; font-weight: 400;")}>USDC</span></dd>
                  </div>
                ))}
              </dl>
              <div style={st("display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-top: 4px; border-top: 1px dashed #D4D4D8; font-size: 12px; color: #6B6B6B; flex-wrap: wrap;")}>
                <span style={st("padding-top: 12px;")}>Parts sum exactly to the payment</span>
                <Link to={`/r/${HERO_SALE.address}`} style={st("padding-top: 12px; font-size: 13px; font-weight: 500;")}>View full receipt ↗</Link>
              </div>
            </article>
          </div>
        </section>

        {/* Proof strip: honest, no logos */}
        <section aria-label="What is live" style={st("border-top: 1px solid #EBEBEB; border-bottom: 1px solid #EBEBEB; background: #FAFAFA;")}>
          <div style={st("max-width: 1280px; margin: 0 auto; padding: 20px clamp(16px, 4vw, 48px); display: flex; flex-wrap: wrap; gap: 12px 40px; align-items: center; font-size: 13px; color: #6B6B6B;")}>
            <span style={st("display: inline-flex; align-items: center; gap: 8px;")}><span aria-hidden="true" style={st("width: 6px; height: 6px; border-radius: 9999px; background: #15B042;")} />Program live on devnet <a className="mono" href="https://explorer.solana.com/address/AC6AtoRALLszNGNLmHte2UXKzCqBYQKhPdtq5qs77nkL?cluster=devnet" target="_blank" rel="noreferrer" style={st("color: #333333;")}>AC6A…7nkL</a></span>
            <span>Standard x402 <span className="mono" style={st("color: #333333;")}>exact</span> scheme, settled by the Coinbase CDP facilitator</span>
            <span>Real end-to-end sale with a public receipt</span>
            {stats.data && <span className="tn">{stats.data.totals.settled} settled sales on devnet</span>}
            <span>Mainnet: <span style={st("color: #333333;")}>[MAINNET DATE]</span></span>
          </div>
        </section>

        {/* How it works */}
        <section id="how" style={st(SECTION)}>
          <div style={st("display: flex; flex-direction: column; gap: 12px; max-width: 680px; margin-bottom: 56px;")}>
            <h2 style={st(H2)}>One sale, four moves. <span style={st("color: #6B6B6B;")}>Every one of them on-chain.</span></h2>
          </div>
          <ol style={st("list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(min(260px, 100%), 1fr)); gap: 0; border-top: 1px solid #EBEBEB;")}>
            <li style={st("padding: 24px 24px 32px 0; display: flex; flex-direction: column; gap: 12px; border-right: 1px solid #EBEBEB;")}>
              <span className="mono" style={st("font-size: 11px; letter-spacing: 0.08em; color: #6B6B6B;")}>01 · MERCHANT</span>
              <h3 style={st("font-size: 20px; line-height: 26px; letter-spacing: -0.015em; font-weight: 500; color: #111111;")}>Create a campaign</h3>
              <p style={st("font-size: 14px; line-height: 20px; color: #6B6B6B;")}>Set a commission, a commission budget (a cap, not escrow) and a refund hold. Sign the listing with your wallet.</p>
              <div className="tn" style={st("margin-top: 8px; display: flex; flex-direction: column; gap: 6px;")}>
                {[["Commission", "15%"], ["Budget cap", "50.00 USDC"], ["Hold", "120 s"]].map(([k, v]) => (
                  <div key={k} style={st("display: flex; justify-content: space-between; font-size: 12px; color: #6B6B6B;")}><span>{k}</span><span style={st("color: #111111; font-weight: 500;")}>{v}</span></div>
                ))}
              </div>
            </li>
            <li style={st("padding: 24px 24px 32px 24px; display: flex; flex-direction: column; gap: 12px; border-right: 1px solid #EBEBEB;")}>
              <span className="mono" style={st("font-size: 11px; letter-spacing: 0.08em; color: #6B6B6B;")}>02 · DISTRIBUTOR</span>
              <h3 style={st("font-size: 20px; line-height: 26px; letter-spacing: -0.015em; font-weight: 500; color: #111111;")}>Share a referral</h3>
              <p style={st("font-size: 14px; line-height: 20px; color: #6B6B6B;")}>A person or an agent shares the service. Their wallet address is their referral ID.</p>
              <div className="mono" style={st("margin-top: 8px; font-size: 12px; color: #333333; background: #F4F4F5; border-radius: 8px; padding: 8px 10px; overflow-wrap: anywhere;")}>noux.so/r/9fQe…Lm3a/brief</div>
            </li>
            <li style={st("padding: 24px 24px 32px 24px; display: flex; flex-direction: column; gap: 12px; border-right: 1px solid #EBEBEB;")}>
              <span className="mono" style={st("font-size: 11px; letter-spacing: 0.08em; color: #6B6B6B;")}>03 · BUYER</span>
              <h3 style={st("font-size: 20px; line-height: 26px; letter-spacing: -0.015em; font-weight: 500; color: #111111;")}>Pays with a signed claim</h3>
              <p style={st("font-size: 14px; line-height: 20px; color: #6B6B6B;")}>The buyer gets a 10-minute claim binding them to that distributor and price, then pays via x402.</p>
              <div style={st("margin-top: 8px; display: flex; gap: 6px; flex-wrap: wrap;")}><Tag>402</Tag><Tag>X-PAYMENT</Tag><Tag green>200 OK</Tag></div>
            </li>
            <li style={st("padding: 24px 0 32px 24px; display: flex; flex-direction: column; gap: 12px;")}>
              <span className="mono" style={st("font-size: 11px; letter-spacing: 0.08em; color: #6B6B6B;")}>04 · PROGRAM</span>
              <h3 style={st("font-size: 20px; line-height: 26px; letter-spacing: -0.015em; font-weight: 500; color: #111111;")}>Splits and leaves a receipt</h3>
              <p style={st("font-size: 14px; line-height: 20px; color: #6B6B6B;")}>After the hold, the program pays merchant, distributor and fee in one settlement.</p>
              <div aria-hidden="true" style={st("margin-top: 12px; display: flex; gap: 3px; height: 10px;")}><div style={st("flex: 84; background: #111111; border-radius: 3px;")} /><div style={st("flex: 15; background: #0F766E; border-radius: 3px;")} /><div style={st("flex: 2; background: #D4D4D8; border-radius: 3px;")} /></div>
            </li>
          </ol>
        </section>

        {/* The math */}
        <section id="math" style={st(SECTION)}>
          <div style={st("display: grid; grid-template-columns: repeat(auto-fit, minmax(min(420px, 100%), 1fr)); gap: 48px; align-items: start;")}>
            <div style={st("display: flex; flex-direction: column; gap: 16px; max-width: 480px;")}>
              <h2 style={st(H2)}>The math is the product. <span style={st("color: #6B6B6B;")}>Try it.</span></h2>
              <p style={st("font-size: 16px; line-height: 24px; color: #333333;")}>Fee and commission are rounded down to the smallest USDC unit. The merchant gets the remainder, so the three parts always add up to exactly what the buyer paid.</p>
              <p style={st("font-size: 14px; line-height: 20px; color: #6B6B6B;")}>Commission is capped by what is left in the campaign budget. If the cap applies, the receipt says so.</p>
            </div>
            <Simulator />
          </div>
        </section>

        {/* Code and result */}
        <section style={st(SECTION)}>
          <div style={st("display: flex; flex-direction: column; gap: 12px; max-width: 680px; margin-bottom: 48px;")}>
            <h2 style={st(H2)}>Your endpoint keeps working. <span style={st("color: #6B6B6B;")}>It just learns to share.</span></h2>
            <p style={st("font-size: 16px; line-height: 24px; color: #333333;")}>Add the gateway in front of a paid route. With a valid claim, the buyer pays into a per-sale vault. Without one, it is a plain purchase and you keep 100%.</p>
          </div>
          <div style={st("display: grid; grid-template-columns: repeat(auto-fit, minmax(min(460px, 100%), 1fr)); gap: 16px;")}>
            <figure style={st("margin: 0; border: 1px solid #EBEBEB; border-radius: 16px; overflow: hidden; background: #FFFFFF;")}>
              <figcaption style={st("height: 44px; display: flex; align-items: center; gap: 8px; padding: 0 8px 0 16px; border-bottom: 1px solid #EBEBEB; background: #FAFAFA;")}>
                <span className="mono" style={st("font-size: 12px; color: #111111;")}>server.ts</span><span style={{ flex: 1 }} /><span style={st("font-size: 12px; color: #6B6B6B;")}>Hono · Node</span>
              </figcaption>
              <pre className="mono" style={st("margin: 0; padding: 20px; font-size: 13px; line-height: 22px; color: #333333; overflow-x: auto;")}>
                <span style={st("color: #0058B0;")}>import</span>{" { Hono } "}<span style={st("color: #0058B0;")}>from</span> <span style={st("color: #8A4B00;")}>"hono"</span>{";\n"}
                <span style={st("color: #0058B0;")}>import</span>{" { nouxGateway } "}<span style={st("color: #0058B0;")}>from</span> <span style={st("color: #8A4B00;")}>"@noux/gateway"</span>{";\n\n"}
                <span style={st("color: #0058B0;")}>const</span>{" app = "}<span style={st("color: #0058B0;")}>new</span>{" Hono();\n\n"}
                <span style={st("background: #F0FDFA; display: inline-block; width: calc(100% + 40px); margin: 0 -20px; padding: 0 20px; border-left: 2px solid #0F766E;")}>
                  {"app.use("}<span style={st("color: #8A4B00;")}>"/v1/brief"</span>{", nouxGateway({\n  campaign: "}<span style={st("color: #8A4B00;")}>"B7DSpwzF…WBWT"</span>{",\n  price: "}<span style={st("color: #8A4B00;")}>"0.10"</span>{",        "}<span style={st("color: #6B6B6B;")}>// USDC, must equal the claim</span>{"\n  network: "}<span style={st("color: #8A4B00;")}>"solana-devnet"</span>{",\n}));"}
                </span>
                {"\n\napp.get("}<span style={st("color: #8A4B00;")}>"/v1/brief"</span>{", (c) => c.json(brief()));"}
              </pre>
            </figure>
            <figure style={st("margin: 0; border: 1px solid #EBEBEB; border-radius: 16px; overflow: hidden; background: #FFFFFF; display: flex; flex-direction: column;")}>
              <figcaption style={st("height: 44px; display: flex; align-items: center; gap: 8px; padding: 0 16px; border-bottom: 1px solid #EBEBEB; background: #FAFAFA;")}><span className="mono" style={st("font-size: 12px; color: #111111;")}>What the buyer sees</span></figcaption>
              <ol className="mono" style={st("list-style: none; margin: 0; padding: 12px 0; font-size: 12px; line-height: 18px; flex: 1;")}>
                {[
                  ["→", <>GET /v1/brief<br /><span style={st("color: #6B6B6B;")}>x-noux-claim: eyJ2IjoxLCJjYW1w…</span></>, "", "#111111"],
                  ["←", <>402 Payment Required<br /><span style={st("color: #6B6B6B;")}>payTo: sale vault 3hVd…p8Rk</span></>, "claim checked", "#111111"],
                  ["→", <>X-PAYMENT · 0.100000 USDC</>, "payer = claim buyer", "#111111"],
                  ["←", <>200 OK · resource served</>, "", "#0E7A2F"],
                ].map(([arrow, body, note, color], i) => (
                  <li key={i} style={st("display: grid; grid-template-columns: 28px 1fr auto; gap: 12px; padding: 10px 20px; align-items: start;")}>
                    <span style={st("color: #6B6B6B;")}>{arrow}</span><span style={{ color: color as string }}>{body}</span>
                    <span style={st("font-family: Inter, sans-serif; font-size: 12px; color: #6B6B6B;")}>{note}</span>
                  </li>
                ))}
              </ol>
              <div style={st("border-top: 1px solid #EBEBEB; padding: 16px 20px; display: flex; flex-direction: column; gap: 10px;")}>
                <div aria-hidden="true" style={st("display: flex; gap: 3px; height: 8px;")}><div style={st("flex: 84; background: #111111; border-radius: 3px;")} /><div style={st("flex: 15; background: #0F766E; border-radius: 3px;")} /><div style={st("flex: 2; background: #D4D4D8; border-radius: 3px;")} /></div>
                <div style={st("display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; font-size: 13px;")}><span style={st("color: #6B6B6B;")}>Settles after the campaign’s hold</span><Link to={`/r/${HERO_SALE.address}`} style={st("font-weight: 500;")}>Receipt {HERO_SALE.short} ↗</Link></div>
              </div>
            </figure>
          </div>
        </section>

        {/* Roles bento */}
        <section style={st(SECTION)}>
          <div style={st("display: flex; flex-direction: column; gap: 12px; max-width: 680px; margin-bottom: 48px;")}>
            <h2 style={st(H2)}>Built for three people. <span style={st("color: #6B6B6B;")}>And their agents.</span></h2>
            <p style={st("font-size: 13px; color: #6B6B6B;")}>The figures in these three cards are illustrative examples, not live data.</p>
          </div>
          <div style={st("display: grid; grid-template-columns: repeat(auto-fit, minmax(min(340px, 100%), 1fr)); gap: 16px;")}>
            <div style={st("background: #F4F4F5; border-radius: 24px; padding: 28px; display: flex; flex-direction: column; gap: 12px; min-height: 340px;")}>
              <span style={st("font-size: 13px; font-weight: 500; color: #6B6B6B;")}>Merchants</span>
              <h3 style={st("font-size: 24px; line-height: 30px; letter-spacing: -0.02em; font-weight: 500; color: #111111;")}>Spend your budget only on buyers who paid.</h3>
              <div style={st("margin-top: auto; background: #FFFFFF; border-radius: 12px; padding: 16px; display: flex; flex-direction: column; gap: 10px; " + CARD_SHADOW)}>
                <div className="tn" style={st("display: flex; justify-content: space-between; font-size: 13px;")}><span style={st("color: #333333;")}>Commission budget</span><span style={st("color: #6B6B6B;")}>31.00 of 50.00 USDC used</span></div>
                <div role="progressbar" aria-label="Budget used" aria-valuenow={62} aria-valuemin={0} aria-valuemax={100} style={st("height: 6px; background: #F4F4F5; border-radius: 9999px; overflow: hidden;")}><div style={st("width: 62%; height: 100%; background: #111111; border-radius: 9999px;")} /></div>
                <span style={st("font-size: 12px; color: #6B6B6B;")}>When it runs out, buyers still pay. You just stop paying commission.</span>
              </div>
            </div>
            <div style={st("background: #111111; border-radius: 24px; padding: 28px; display: flex; flex-direction: column; gap: 12px; min-height: 340px; color: #FFFFFF;")}>
              <span style={st("font-size: 13px; font-weight: 500; color: #A1A1AA;")}>Distributors</span>
              <h3 style={st("font-size: 24px; line-height: 30px; letter-spacing: -0.02em; font-weight: 500; color: #FFFFFF;")}>Get paid at settlement, straight to your wallet.</h3>
              <div style={st("margin-top: auto; background: #1C1C1C; border: 1px solid #2B2B2B; border-radius: 12px; padding: 16px; display: flex; flex-direction: column; gap: 12px;")}>
                <div style={st("display: flex; justify-content: space-between; align-items: center; font-size: 13px;")}><span style={st("color: #D4D4D8;")}>Settled to 9fQe…Lm3a</span><span className="tn" style={st("color: #5EEAD4; font-weight: 500;")}>+0.015000 USDC</span></div>
                <div style={st("display: flex; justify-content: space-between; align-items: center; font-size: 13px;")}><span style={st("color: #D4D4D8;")}>Held · 1:42 left</span><span className="tn" style={st("color: #FFFFFF; font-weight: 500;")}>+0.004500 USDC</span></div>
                <span style={st("font-size: 12px; color: #A1A1AA;")}>Humans share a link. Agents send a header. Same commission.</span>
              </div>
            </div>
            <div style={st("background: #F4F4F5; border-radius: 24px; padding: 28px; display: flex; flex-direction: column; gap: 12px; min-height: 340px;")}>
              <span style={st("font-size: 13px; font-weight: 500; color: #6B6B6B;")}>Buyers</span>
              <h3 style={st("font-size: 24px; line-height: 30px; letter-spacing: -0.02em; font-weight: 500; color: #111111;")}>Same price, with or without a referral.</h3>
              <div style={st("margin-top: auto; background: #FFFFFF; border-radius: 12px; padding: 16px; display: flex; flex-direction: column; gap: 8px; " + CARD_SHADOW)}>
                <span style={st("font-size: 13px; color: #111111; font-weight: 500;")}>If the service fails after you pay</span>
                <span style={st("font-size: 13px; line-height: 20px; color: #333333;")}>The merchant can refund you before settlement. After settlement it is final. A refund is the merchant’s choice, not a guarantee.</span>
              </div>
            </div>
          </div>
        </section>

        {/* Security: honest */}
        <section id="security" style={st(SECTION)}>
          <div style={st("display: grid; grid-template-columns: repeat(auto-fit, minmax(min(380px, 100%), 1fr)); gap: 48px;")}>
            <div style={st("display: flex; flex-direction: column; gap: 16px;")}>
              <h2 style={st(H2)}>What we protect. <span style={st("color: #6B6B6B;")}>And what we don’t, yet.</span></h2>
              <p style={st("font-size: 16px; line-height: 24px; color: #333333; max-width: 460px;")}>We would rather you trust the numbers than the marketing. Here is the model in plain words.</p>
              <Link to="/docs/quickstart" style={st("font-size: 14px; font-weight: 500;")}>Read the security notes →</Link>
            </div>
            <div style={st("display: grid; grid-template-columns: repeat(auto-fit, minmax(min(260px, 100%), 1fr)); gap: 32px;")}>
              <div style={st("display: flex; flex-direction: column; gap: 4px;")}>
                <span style={st("font-size: 13px; font-weight: 500; color: #0E7A2F; display: flex; align-items: center; gap: 6px;")}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#0E7A2F" strokeWidth="2" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>Rejected on-chain or in the gateway</span>
                <ul style={st("margin: 8px 0 0; padding: 0; list-style: none; display: flex; flex-direction: column; font-size: 14px; color: #333333;")}>
                  {["Forged or edited claims", "Replayed claims and double settlement", "Self-referral and expired claims", "Paying someone else’s claim", "Spending past the budget", "A merchant setting its own protocol fee or fee wallet"].map((t, i, a) => (
                    <li key={t} style={st("padding: 10px 0; " + (i < a.length - 1 ? "border-bottom: 1px solid #EBEBEB;" : ""))}>{t}</li>
                  ))}
                </ul>
              </div>
              <div style={st("display: flex; flex-direction: column; gap: 4px;")}>
                <span style={st("font-size: 13px; font-weight: 500; color: #8A4B00; display: flex; align-items: center; gap: 6px;")}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#8A4B00" strokeWidth="2" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16h.01" /></svg>Trust assumptions</span>
                <ul style={st("margin: 8px 0 0; padding: 0; list-style: none; display: flex; flex-direction: column; font-size: 14px; color: #333333;")}>
                  {["Price and payer checks live in the merchant’s gateway", "A merchant can refund to skip a commission. Refund rates are public.", "The protocol fee (max 5%) and its wallet are set on-chain by one admin key", "The program upgrade key is one wallet today", "No independent audit yet"].map((t, i, a) => (
                    <li key={t} style={st("padding: 10px 0; " + (i < a.length - 1 ? "border-bottom: 1px solid #EBEBEB;" : ""))}>{t}</li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </section>

        {/* Directory preview: live */}
        <section style={st(SECTION)}>
          <div style={st("display: flex; align-items: end; justify-content: space-between; gap: 24px; flex-wrap: wrap; margin-bottom: 32px;")}>
            <h2 style={st(H2)}>Open campaigns. <span style={st("color: #6B6B6B;")}>Pick one to promote.</span></h2>
            <Link to="/campaigns" style={st("font-size: 14px; font-weight: 500;")}>See all campaigns →</Link>
          </div>
          {camps.loading && <p role="status" style={st("font-size: 14px; color: #6B6B6B;")}>{camps.waking ? "Waking the index… this can take up to a minute on the free server." : "Loading campaigns…"}</p>}
          {camps.error && <p role="alert" style={st("font-size: 14px; color: #B42318;")}>Couldn’t load campaigns right now. <button type="button" onClick={camps.retry} style={st("border: 0; background: none; color: #0F766E; font: 500 14px Inter, sans-serif; cursor: pointer; padding: 0;")}>Try again</button></p>}
          {camps.data && camps.data.items.length === 0 && <p style={st("font-size: 14px; color: #6B6B6B;")}>No campaigns are listed yet.</p>}
          {camps.data && camps.data.items.length > 0 && (
            <div style={st("display: grid; grid-template-columns: repeat(auto-fit, minmax(min(300px, 100%), 1fr)); gap: 16px;")}>
              {camps.data.items.map((c) => (
                <Link key={c.address} className="ch press" to={`/campaigns/${c.address}`} style={st("display: flex; flex-direction: column; gap: 14px; padding: 20px; border: 1px solid #EBEBEB; border-radius: 12px; color: #333333; background: #FFFFFF;")}>
                  <div style={st("display: flex; align-items: center; gap: 8px;")}>
                    <span style={st("font-size: 16px; line-height: 20px; letter-spacing: -0.01em; font-weight: 500; color: #111111;")}>{c.listing?.name ?? "Unlisted campaign"}</span>
                    {c.listing?.isSample && <SampleBadge />}
                  </div>
                  <span style={st("font-size: 13px; color: #6B6B6B;")}>{c.listing ? CATEGORIES[c.listing.category] ?? c.listing.category : "—"}</span>
                  <div className="tn" style={st("display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; font-size: 13px;")}>
                    <div style={st("display: flex; flex-direction: column; gap: 2px;")}><span style={st("color: #6B6B6B; font-size: 12px;")}>Price</span><span style={st("color: #111111; font-weight: 500;")}>{c.listing?.displayPrice ?? "—"}</span></div>
                    <div style={st("display: flex; flex-direction: column; gap: 2px;")}><span style={st("color: #6B6B6B; font-size: 12px;")}>Commission</span><span style={st("color: #0F766E; font-weight: 500;")}>{bpsPct(c.commissionBps, 0)}</span></div>
                  </div>
                  <span style={st("font-size: 12px; color: #6B6B6B; border-top: 1px solid #EBEBEB; padding-top: 12px;")}>Distributors earn a commission on this campaign.</span>
                </Link>
              ))}
            </div>
          )}
        </section>

        {/* Final CTA */}
        <section style={st("max-width: 1280px; margin: 0 auto; padding: 128px clamp(16px, 4vw, 48px);")}>
          <div style={st("background: #FAFAFA; border: 1px solid #EBEBEB; border-radius: 32px; padding: clamp(32px, 6vw, 72px); display: flex; flex-direction: column; align-items: flex-start; gap: 24px;")}>
            <h2 style={st("font-size: clamp(2rem, 1.4rem + 2vw, 3.5rem); line-height: 1.02; letter-spacing: -0.035em; font-weight: 500; color: #111111; max-width: 760px; text-wrap: balance;")}>Set up your first campaign in about fifteen minutes.</h2>
            <p style={st("font-size: 16px; line-height: 24px; color: #333333; max-width: 560px;")}>Add the gateway, create a campaign, run the keeper. If you sell a paid x402 endpoint, we’ll help you set it up.</p>
            <div style={st("display: flex; gap: 12px; flex-wrap: wrap;")}>
              <Link className="press bi" to="/docs/quickstart" style={st("height: 44px; padding: 0 20px; border-radius: 9999px; background: #111111; color: #FFFFFF; font-size: 15px; font-weight: 500; display: inline-flex; align-items: center;")}>Read the quickstart</Link>
              <a className="press bs" href="mailto:[YOUR EMAIL]" style={st("height: 44px; padding: 0 20px; border-radius: 9999px; background: #FFFFFF; color: #111111; border: 1px solid #D4D4D8; font-size: 15px; font-weight: 500; display: inline-flex; align-items: center;")}>Talk to the team</a>
            </div>
          </div>
        </section>
      </main>
      <SiteFooter disclosure={stats.data?.disclosure} />
    </Page>
  );
}
