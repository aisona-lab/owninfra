import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const base = process.env.APP_URL ?? "http://localhost:3217";
const shots = process.env.SHOTS_DIR;
const widths = [320, 400, 427, 640, 1100, 1280];
const failures = [];
const check = (ok, message) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
  if (!ok) failures.push(message);
};

async function signIn(browser, email, width = 1280) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(`${m.text().slice(0, 160)} ${m.location().url}`));
  page.on("response", (r) => r.status() === 404 && errors.push(`404 ${r.url()}`));
  await page.goto(`${base}/api/auth/signin`);
  await page.fill('input[name="email"]', email);
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith("/api/auth")), page.click('button[type="submit"]')]);
  return { page, errors };
}

const browser = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {});
const stamp = Date.now();
const longWord = "x".repeat(140);
const fin = await signIn(browser, "finance@acme.example");
const vendor = await fin.page.request.post(`${base}/api/e/vendors`, {
  data: { name: `Vendor${"v".repeat(60)}${stamp}`, tax_id: `W${stamp}`, contact_email: `${"accounts.payable.department".repeat(3)}@${"very-long-subdomain".repeat(3)}.example.com` },
});
check(vendor.status() === 201, `seed vendor with a long email -> ${vendor.status()}`);
const vendorId = (await vendor.json()).id;

const req = await signIn(browser, "requester@acme.example");
const dept = (await (await req.page.request.get(`${base}/api/e/departments`)).json())[0].id;
const blank = await req.page.request.post(`${base}/api/e/purchase_requests`, { data: { title: "   ", amount: "1", department: dept, vendor: vendorId, justification: "j" } });
const blankBody = await blank.json();
check(blank.status() === 422 && blankBody.fields?.title === "is required", `API whitespace-only title -> ${blank.status()} ${JSON.stringify(blankBody)}`);
const pr = await req.page.request.post(`${base}/api/e/purchase_requests`, { data: { title: `${"x".repeat(140 - String(stamp).length)}${stamp}`, amount: "1", department: dept, vendor: vendorId, justification: longWord } });
check(pr.status() === 201, `seed request with a 140-character unbroken title -> ${pr.status()} ${pr.status() === 201 ? "" : await pr.text()}`);
const prId = (await pr.json()).id;
await req.page.request.post(`${base}/api/e/purchase_requests/${prId}/transitions/submit`);

const pages = [
  ["requester@acme.example", "list", "/e/purchase_requests"],
  ["requester@acme.example", "create", "/e/purchase_requests#create", async (p) => p.click("button:text-is('Create')").then(() => p.locator(".field .error").first().waitFor())],
  ["requester@acme.example", "detail", `/e/purchase_requests/${prId}`],
  ["manager@acme.example", "inbox", "/inbox"],
  ["admin@acme.example", "audit", "/admin/audit", async (p) => p.locator("table.rows details").first().click()],
  ["finance@acme.example", "vendors", "/e/vendors"],
  ["admin@acme.example", "nav-open", "/", async (p) => (await p.locator("nav details.menu").isVisible()) && p.click("nav details.menu summary")],
];
if (shots) mkdirSync(shots, { recursive: true });
for (const width of widths) {
  const sessions = {};
  for (const [email, name, path, act] of pages) {
    sessions[email] ??= await signIn(browser, email, width);
    const { page } = sessions[email];
    await page.goto(base + path.replace("#create", ""));
    if (act) await act(page);
    const m = await page.evaluate(() => ({ sw: globalThis.document.documentElement.scrollWidth, cw: globalThis.document.documentElement.clientWidth }));
    check(m.sw === m.cw, `${width}px ${name}: scrollWidth=${m.sw} clientWidth=${m.cw}`);
    if (shots) await page.screenshot({ path: `${shots}/${name}-${width}.png`, fullPage: true, caret: "initial" });
  }
  for (const [email, { errors }] of Object.entries(sessions)) check(errors.length === 0, `${width}px console errors and 404s for ${email}: ${errors.length ? errors.join(" | ") : "none"}`);
}
await browser.close();
console.log(failures.length ? `${failures.length} failed` : "all checks passed");
process.exit(failures.length ? 1 : 0);
