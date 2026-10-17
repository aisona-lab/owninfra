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

const blankEmail = await fin.page.request.post(`${base}/api/e/vendors`, { data: { name: `Blank email ${stamp}`, tax_id: `B${stamp}`, contact_email: "" } });
const blankEmailBody = await blankEmail.json();
check(blankEmail.status() === 201 && blankEmailBody.contact_email === null, `API optional email "" -> ${blankEmail.status()} contact_email=${JSON.stringify(blankEmailBody.contact_email)}`);
const zw = await req.page.request.post(`${base}/api/e/purchase_requests`, { data: { title: "\u200b", amount: "1", department: dept, vendor: vendorId, justification: "j" } });
const zwBody = await zw.json();
check(zw.status() === 422 && zwBody.fields?.title === "is required", `API required title "\\u200b" -> ${zw.status()} ${JSON.stringify(zwBody)}`);
const blankDate = await req.page.request.post(`${base}/api/e/purchase_requests`, { data: { title: `Blank date ${stamp}`, amount: "1", department: dept, vendor: vendorId, justification: "j", needed_by: " \u200b\ufeff " } });
const blankDateBody = await blankDate.json();
check(blankDate.status() === 201 && blankDateBody.needed_by === null, `API optional date " \\u200b\\ufeff " -> ${blankDate.status()} needed_by=${JSON.stringify(blankDateBody.needed_by)}`);

await req.page.goto(`${base}/e/purchase_requests`);
await req.page.fill("#f-title", "\u200b");
await req.page.fill("#f-amount", "1");
await req.page.fill("#f-justification", "j");
await req.page.selectOption("#f-department", dept);
await req.page.selectOption("#f-vendor", vendorId);
await req.page.click("button:text-is('Create')");
await req.page.locator("#e-title").waitFor();
const formError = await req.page.locator("#e-title").innerText();
check(formError === "title is required", `form required title "\\u200b" -> inline "${formError}"`);

await fin.page.goto(`${base}/e/vendors`);
await fin.page.fill("#f-name", `Form blank email ${stamp}`);
await fin.page.fill("#f-tax_id", `F${stamp}`);
await fin.page.fill("#f-contact_email", " \u200b ");
await Promise.all([fin.page.waitForURL(/vendors\/[0-9a-f-]{36}$/), fin.page.click("button:text-is('Create')")]);
const formVendor = await (await fin.page.request.get(`${base}/api/e/vendors/${fin.page.url().split("/").pop()}`)).json();
check(formVendor.contact_email === null, `form optional email " \\u200b " -> contact_email=${JSON.stringify(formVendor.contact_email)}`);

const joined = ["👨‍👩‍👧", "می‌خواهم", "क्‍ष"];
for (const v of joined) {
  const r = await req.page.request.post(`${base}/api/e/purchase_requests`, { data: { title: `\u200b ${v} \ufeff`, amount: "1", department: dept, vendor: vendorId, justification: "j", currency: "", description: "first\r\n  second\r\n" } });
  const body = await r.json();
  check(r.status() === 201 && body.title === v && body.currency === "EUR" && body.description === "first\n  second", `API title ${JSON.stringify(v)} -> ${r.status()} title=${JSON.stringify(body.title)} currency=${body.currency} description=${JSON.stringify(body.description)}`);
}

await req.page.goto(`${base}/e/purchase_requests`);
await req.page.fill("#f-title", `\u200b ${joined[1]} \ufeff`);
await req.page.fill("#f-amount", "1");
await req.page.fill("#f-justification", "j");
await req.page.fill("#f-description", "first\n  second\n");
await req.page.selectOption("#f-currency", "");
await req.page.selectOption("#f-department", dept);
await req.page.selectOption("#f-vendor", vendorId);
await Promise.all([req.page.waitForURL(/purchase_requests\/[0-9a-f-]{36}$/), req.page.click("button:text-is('Create')")]);
const viaForm = await (await req.page.request.get(`${base}/api/e/purchase_requests/${req.page.url().split("/").pop()}`)).json();
check(viaForm.title === joined[1] && viaForm.currency === "EUR" && viaForm.description === "first\n  second", `form title ${JSON.stringify(joined[1])}, blank currency, CRLF description -> title=${JSON.stringify(viaForm.title)} currency=${viaForm.currency} description=${JSON.stringify(viaForm.description)}`);

const mgr = await signIn(browser, "manager@acme.example");
const draft = await (await req.page.request.post(`${base}/api/e/purchase_requests`, { data: { title: `Exploit ${stamp}`, amount: "1", department: dept, vendor: vendorId, justification: "j", description: "to clear" } })).json();
const step = async (label, res, want) => {
  const body = await res.text();
  check(res.status() === want, `exploit ${label} -> ${res.status()} ${body.slice(0, 160)}`);
  return body;
};
await step("requester PATCH rejection_reason on draft", await req.page.request.patch(`${base}/api/e/purchase_requests/${draft.id}`, { data: { rejection_reason: "pre-filled" } }), 422);
await step("requester submit", await req.page.request.post(`${base}/api/e/purchase_requests/${draft.id}/transitions/submit`), 200);
await step("manager reject with blank reason", await mgr.page.request.post(`${base}/api/e/purchase_requests/${draft.id}/transitions/manager_reject`, { data: { rejection_reason: " \u200b " } }), 422);
await step("manager reject with no reason", await mgr.page.request.post(`${base}/api/e/purchase_requests/${draft.id}/transitions/manager_reject`), 422);
await mgr.page.goto(`${base}/e/purchase_requests/${draft.id}`);
const rejectForm = mgr.page.locator("form:has(button:text-is('manager_reject'))");
await rejectForm.locator("#f-rejection_reason").fill("   ");
await rejectForm.locator("button").click();
await rejectForm.locator("#e-rejection_reason, .error").first().waitFor();
check((await rejectForm.locator(".error").first().innerText()).includes("requires rejection_reason"), `exploit form reject with blank reason -> "${await rejectForm.locator(".error").first().innerText()}"`);
await step("manager reject with a reason", await mgr.page.request.post(`${base}/api/e/purchase_requests/${draft.id}/transitions/manager_reject`, { data: { rejection_reason: "over budget" } }), 200);

const clearable = await (await req.page.request.post(`${base}/api/e/purchase_requests`, { data: { title: `Clear ${stamp}`, amount: "1", department: dept, vendor: vendorId, justification: "j", description: "to clear" } })).json();
const cleared = await req.page.request.patch(`${base}/api/e/purchase_requests/${clearable.id}`, { data: { description: " \u200b " } });
const clearedBody = await cleared.json();
check(cleared.status() === 200 && clearedBody.description === null, `blank PATCH of optional description -> ${cleared.status()} description=${JSON.stringify(clearedBody.description)}`);
const blankRequired = await req.page.request.patch(`${base}/api/e/purchase_requests/${clearable.id}`, { data: { title: "\u200b" } });
check(blankRequired.status() === 422, `blank PATCH of required title -> ${blankRequired.status()} ${await blankRequired.text()}`);

const zwEmail = await fin.page.request.post(`${base}/api/e/vendors`, { data: { name: `ZW ${stamp}`, tax_id: `Z${stamp}`, contact_email: "ap\u200b@acme.example" } });
check(zwEmail.status() === 422, `API email with interior U+200B -> ${zwEmail.status()} ${await zwEmail.text()}`);
await fin.page.goto(`${base}/e/vendors`);
await fin.page.fill("#f-name", `ZW form ${stamp}`);
await fin.page.fill("#f-tax_id", `ZF${stamp}`);
await fin.page.fill("#f-contact_email", "ap\u200b@acme.example");
await fin.page.click("button:text-is('Create')");
await fin.page.locator("#e-contact_email").waitFor();
check((await fin.page.locator("#e-contact_email").innerText()) === "contact_email must be an email address", `form email with interior U+200B -> "${await fin.page.locator("#e-contact_email").innerText()}"`);

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
