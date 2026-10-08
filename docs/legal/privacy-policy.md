# RaphAi Privacy Policy

**Version:** 2.0
**Effective date:** 8 October 2026
**Last updated:** 8 October 2026

This Privacy Policy explains what personal data the RaphAi app collects, why we collect it, where we keep it, who we share it with, how long we keep it, how we protect it, and the rights you have. We have written it in simple English. If anything is unclear, write to our Grievance Officer (Section 17).

RaphAi is an Android app (package `com.raphai.app`) that helps you track your health, fitness, habits and personal money in one place.

> **Our promises**
>
> - **We never sell your data.** Not to advertisers, not to data brokers, not to anyone.
> - **No loans.** We never give loans, check your credit, or use your data to decide credit, lending or insurance.
> - **Health Connect data is never used for ads.** Not for showing ads, targeting ads or measuring ads.
> - **You can export or delete your data anytime.** In the app: **You → Privacy Centre → Export my data / Delete account**. Without the app: <https://raphai-backend.onrender.com/delete-account>.

---

## Data we collect — one-page summary

"SPDI" means *sensitive personal data or information* under Rule 3 of the IT (Reasonable Security Practices and Procedures and Sensitive Personal Data or Information) Rules, 2011. We give SPDI extra protection. Where the law is not fully clear, we **treat the data as SPDI to be safe**.

| Data | Why we use it | Where it is stored | How long we keep it | SPDI? |
|---|---|---|---|---|
| Name, email | Create and run your account; contact you | Supabase database, Mumbai, India | Until you delete your account (we may delete it after 3 years of inactivity — Section 10) | No |
| Password | Sign-in security | Mumbai, as a one-way **bcrypt hash** only | Until you delete your account | **Yes** — Rule 3(i) |
| Login token | Keep you signed in | Your phone's secure storage | Until you sign out, delete the account or uninstall | **Yes** (a password-like secret) |
| Sex, age, height, weight, activity level, goal, pace, step goal | Calculate calorie, water, step and body targets | Mumbai | Until you delete your account | Height and weight: **Yes** — Rule 3(iii). Sex, age, goal: No |
| Neck, waist, hip measurements | Estimate body-fat % (the result is calculated on the fly and **not stored**) | Mumbai | Until you delete your account | **Yes** — Rule 3(iii) |
| Food logs, typed food descriptions, custom foods, favourites, water | Track nutrition; turn typed text like "2 rotis and dal" into food entries | Mumbai | Until you delete your account | **Yes** (treated as health data) |
| Sleep, mood (1–5) and mood notes, weight history, workouts | Show progress, trends and insights | Mumbai | Until you delete your account | **Yes** — Rule 3(iii) |
| **Health Connect data:** steps, distance, active calories, exercise sessions, heart rate, resting heart rate, sleep, weight (read in the foreground and in the background) | Show your activity and sleep automatically, including from wearables | Read on your phone, then synced to Mumbai | Until you delete your account, or you ask us to delete it | **Yes** — Rule 3(iii) |
| Phone pedometer steps | Count steps if you don't use Health Connect | Mumbai | Until you delete your account | **Yes** (treated as health data) |
| Expenses (amount, category, UPI / card / cash, note), budgets, savings goals, bills, bill payments, monthly income | Track your money, budgets and bills | Mumbai | Until you delete your account | **Treated as SPDI** (financial information, Rule 3(ii)) — we never collect card, bank account or UPI ID numbers |
| Bill-split names and amounts; SIP / EMI calculator inputs | Split bills; show calculator results | **Only on your phone** (bill split) / **not stored at all** (calculators) | Until you delete them or uninstall | — |
| Computed insights: RaphScore, daily priorities, "life patterns", daily brief | Explain your progress and suggest next steps | Calculated on our server (Singapore) by fixed rules; daily RaphScore history stored in Mumbai | Until you delete your account | **Yes** (derived from health data) |
| Coach questions | Answer your questions | Processed on our server (Singapore) to answer, then discarded — **not stored**. Only a **daily count** of questions is kept (Mumbai) | Questions: **not stored**. Daily count: until you delete your account | Questions: **Yes** while processed (may contain health or money details). Daily count: No |
| Feature-use counts (e.g. how many food parses or Coach questions today) | Apply Free-plan limits fairly | Mumbai | Until you delete your account | No |
| Purchase records from Google Play (purchase token, plan, status, expiry) | Unlock your plan; tax and accounting records | Mumbai | **8 years** (tax law) | No — we never see card or UPI details |
| Consent records (what you agreed to, which version, when) | Prove your consent, as the law requires | Mumbai | Account life **+ 1 year** | No |
| Security logs (IP address, device/browser type, event such as sign-in, failed sign-in, data export or account deletion, time) | Keep the service safe; investigate incidents | Our Mumbai (India) database | **1 year**, then deleted | No |
| Advertising ID and basic device data (**Free plan, only if we add ads**) | Show ads through Google AdMob | Google | Google's own policy | No |

---

## 1. Who we are

RaphAi is run by **Shalem Raj Rooppa, an individual developer operating under the name RaphAi (sole proprietorship)**, based in Andhra Pradesh, India ("**RaphAi**", "**we**", "**us**", "**our**").

- Under the **Digital Personal Data Protection Act, 2023** ("**DPDP Act**"), we are the **Data Fiduciary** and you are the **Data Principal**.
- Under the **Information Technology Act, 2000** ("**IT Act**"), a sole proprietorship counts as a "body corporate" for section 43A, so the **SPDI Rules, 2011** apply to us.

**Grievance Officer and contact person:** Shalem Raj Rooppa — email [SUPPORT EMAIL] — post: [POSTAL ADDRESS], Andhra Pradesh, India. See Section 17.

---

## 2. Who can use RaphAi

RaphAi is only for adults **18 years or older**. The DPDP Act treats anyone under 18 as a child. We do not design RaphAi for children, we do not knowingly collect children's data, and we do not track, profile or target ads at children. At sign-up you confirm you are 18 or older. If we learn that an account belongs to someone under 18, we will delete it and its data. To report this, email [SUPPORT EMAIL].

---

## 3. What we collect, in detail

We collect only what you give us, what you allow the app to read from your phone, and the basic records needed to run your subscription and keep the service secure. The summary table above lists everything. More detail:

### 3.1 Account data
Name, email, and a **bcrypt hash** of your password (we never store or see your actual password). A login token is kept in your phone's encrypted secure storage.
*Planned:* Google sign-in and mobile-number OTP login through Google Firebase Authentication. If we add them, we will receive your Google email/name or your mobile number, and we will update this policy first.

### 3.2 Profile data
Sex, age, height, weight, activity level, goal, pace, daily step goal, monthly income (optional), and neck, waist and hip measurements. Body-fat % is calculated when needed and **not stored**.

### 3.3 Health and wellness logs you enter
Food logs (including the text you type, such as "2 eggs and a glass of milk", which our server turns into food entries using fixed rules — no outside AI), custom foods, favourites, water, sleep hours and quality, mood score and optional note, weight history, workouts, step counts, and your sit-reminder settings. Please only write in notes what you are comfortable storing.

### 3.4 Data from Android Health Connect and your phone
With your separate permission for **each** data type, RaphAi reads from **Health Connect**:

- steps, distance, active calories burned, exercise sessions, heart rate, resting heart rate, sleep and weight.

This data may come from your phone or from wearables and apps (for example Fitbit, Samsung Health, Garmin) that write to Health Connect.

- **Background reading.** If you allow it (`READ_HEALTH_DATA_IN_BACKGROUND`), RaphAi can read this data while the app is closed, so your activity and sleep stay up to date. You can turn background access off at any time and still use the app.
- **Synced to our server.** What we read is sent over an encrypted connection and saved to your account in Mumbai, so you keep your history and can see it on other devices.
- **Phone pedometer.** If you don't use Health Connect, we can count steps with the phone's motion sensor (Physical activity permission, `ACTIVITY_RECOGNITION`).

You can change or remove these permissions at any time in **Phone Settings → Health Connect → App permissions → RaphAi** (or **Phone Settings → Apps → RaphAi → Permissions** for Physical activity).

### 3.5 Money data you enter
Expenses (amount, category, payment mode such as UPI, card or cash, and an optional note), budgets, savings goals, bills, bill payments and monthly income.

- **Stays only on your phone:** bill-split names and amounts.
- **Never stored:** SIP and EMI calculator inputs.
- **We do not collect:** card numbers, bank account numbers, UPI IDs, SMS messages or data from your bank or UPI apps. We do not connect to your bank.

### 3.6 Computed insights
Our server calculates **RaphScore** (a score across life areas such as health, fitness and money), **daily priorities**, **"life patterns"** (for example, "on days you sleep 7+ hours you walk more") and a **daily brief**. These are produced by **fixed rules written by us**, not by an outside AI. They are suggestions, not decisions about you: nothing is decided about your eligibility for anything, and they have no legal effect. We save your daily RaphScore so we can show how it changed.

### 3.7 Coach questions
The RaphAi Coach answers your questions using your messages and the parts of your profile and logs needed to answer.

- **Today** replies come from **rule-based logic on our own server**. No outside AI company sees your questions.
- **Your questions are not stored.** Each question is processed on our server only to work out the answer, and is then discarded. We keep only a **daily count** of how many questions you asked (to apply the Free-plan daily limit fairly).
- **Planned — Google Gemini (opt-in only).** We plan to offer smarter replies using Google's Gemini API. This will be **off by default**. It starts only if you switch it on in **You → Privacy Centre** after reading a clear notice. When on, your chat message and only the summary data needed to answer (for example your goal and recent totals) are sent to Google for processing, possibly outside India. Raw Health Connect records will not be sent unless you separately allow it. You can switch it off at any time and the rule-based Coach keeps working.

### 3.8 Purchase records
Google Play handles all payments. **We never see your card or UPI details.** We receive the purchase token, plan, status and expiry date from Google Play.

### 3.9 Notifications
The app asks for **notification permission** to send reminders you set up (for example, sit reminders, water reminders and bill reminders the day before they are due). You can say no or turn this off any time in phone settings.

### 3.10 Advertising data (Free plan only — planned)
If we add ads to the Free plan, **Google AdMob** may collect your device's advertising ID, IP address and basic device and app-use data. See Section 8.

### 3.11 Technical data
Our server keeps **security logs** (IP address, device/browser type, the event — such as a sign-in, failed sign-in, data export or account deletion — and the time). They are stored in our **Mumbai (India) database for 1 year**, then deleted. We do **not** use third-party analytics or crash-reporting tools today. If we add one, we will update this policy first.

---

## 4. Why we use your data (purpose limitation)

We use your data **only** for the purposes below (SPDI Rule 5(5); DPDP Act section 6(1)). We will ask for fresh consent before using it for any new purpose.

| Purpose | Data used |
|---|---|
| Create, secure and run your account | Account data, login token, security logs |
| Calculate targets and show your progress | Profile, health logs, Health Connect / pedometer data |
| Turn typed food text into food entries | The text you type, our food database |
| Track expenses, budgets, savings goals and bills | Money data, monthly income |
| Produce RaphScore, priorities, life patterns and the daily brief | Profile, health, activity and money data |
| Give Coach replies | Your question (processed, not stored) plus the relevant profile, health and money data |
| Send reminders you set | Reminder settings, bills, notification permission |
| Unlock and manage your plan; keep tax records | Purchase records, account data |
| Show ads on the Free plan (planned) | Advertising ID and device data via AdMob — **never** Health Connect, health or money data |
| Keep the service safe, prevent fraud and misuse, fix bugs | Security logs, account data |
| Answer support requests and grievances | Account data and what you send us |
| Meet legal duties | Purchase records, logs, consent records |

---

## 5. Your consent

- **Before we collect** any SPDI, we ask for your consent in the app and tell you what we collect, why, who receives it, and who we are (SPDI Rule 5(1) and 5(3); DPDP Act sections 5 and 6). Consent given electronically in the app is a valid written record under section 4 of the IT Act.
- **Each optional feature has its own consent.** Health Connect (each data type and background access), Physical activity, notifications, Gemini (planned) and personalised ads (planned) are asked for separately. Nothing is pre-ticked.
- **You may say no.** You can refuse any optional data. If you refuse data that a feature needs, only that feature will not work (SPDI Rule 5(7)).
- **You may withdraw consent at any time, as easily as you gave it** (DPDP Act section 6(4)): use the switches in **You → Privacy Centre**, your phone's permission settings, or email [SUPPORT EMAIL]. After you withdraw, we stop that processing within a reasonable time and tell our service providers to stop too, unless the law requires us to keep something. Withdrawal does not undo processing done before it.
- **Notice in your language.** You can ask for this notice in English or any language in the Eighth Schedule to the Constitution (DPDP Act section 5(3)). Email us and we will provide it.
- We keep a record of each consent (what, which version, yes/no, when) for the life of your account plus 1 year, to prove it.

---

## 6. Health Connect data — Limited Use

RaphAi follows Google Play's rules for Android health permissions and Health Connect ([Google Play guidance](https://support.google.com/googleplay/android-developer/answer/12991134)). Data we get from Health Connect:

- is used **only** to provide and improve the health and fitness features you see in RaphAi;
- is **never** used for advertising, ad targeting, interest-based ads or ad measurement;
- is **never sold**, and never given to advertising platforms or data brokers;
- is **never** used to decide credit, lending, insurance or employment;
- is **not** shared with anyone except: (a) our service providers who run RaphAi for us under contract (Section 7), (b) when you ask us to (for example, an export), (c) when required by law, or (d) in a merger or sale of the business, with the same protections;
- is **not read by people** at RaphAi unless you allow it (for example, in a support request), it is needed for security, or the law requires it;
- is encrypted in transit and at rest.

---

## 7. Who we share data with

**We do not sell your personal data.** We share it only with service providers (**Data Processors**) who help us run RaphAi, under contract, and only as much as they need (DPDP Act section 8(2)). We do **not** disclose your SPDI to anyone else without your prior consent (SPDI Rule 6), except as described below.

| Provider | What they do | Where | Gets health data? |
|---|---|---|---|
| **Supabase** (PostgreSQL on Amazon Web Services) | Stores your account, profile, health, money, insight, consent, security-log and purchase data | **Mumbai, India** (AWS ap-south-1) | Yes (stored, encrypted) |
| **Render** | Runs our app server, which processes your requests and calculates insights | **Singapore** | Yes (processed in transit, not kept long-term) |
| **Expo** | **Only** builds the app and delivers app updates | United States | **No** |
| **Google Play** | Payments, subscriptions and app delivery | Google's global infrastructure | No |
| **Google Firebase Authentication** *(planned)* | Google sign-in and phone OTP | Google's global infrastructure | No |
| **Google Gemini API** *(planned, opt-in only)* | Smarter Coach replies | Google's global infrastructure | Only what you choose to send |
| **Google AdMob** *(planned, Free plan only)* | Shows ads | Google's global infrastructure | **Never** |

**Disclosure without consent — only when the law requires it.** We may share data without asking you:

- with **Government agencies authorised by law** that send us a **written request** stating the purpose, for verifying identity or for preventing, detecting or investigating offences (including cyber incidents) — SPDI Rule 6(1);
- when ordered by a **court** or under any law in force — SPDI Rule 6(2);
- to report a **cyber incident** to CERT-In or a **personal data breach** to the Data Protection Board of India;
- to protect the safety of a person in a medical emergency, as the DPDP Act section 7 allows.

We **never publish** your SPDI (SPDI Rule 6(3)), and anyone who receives it from us must not pass it on (SPDI Rule 6(4)).

**Business transfer.** If RaphAi is merged, sold or reorganised, your data moves only with the same protections as this policy, and we will tell you first.

Google's own use of data is covered by Google's privacy policy: <https://policies.google.com/privacy>.

---

## 8. Ads (Free plan only — planned)

If we add ads:

- Ads appear **only on the Free plan**. Plus, Pro and Elite have no ads.
- Ads **never** appear on health-logging or money-entry screens.
- Ads **never** use Health Connect, health or money data.
- **Personalised ads only if you say yes.** Otherwise you get non-personalised ads, which are based on the current context and rough location, though Google may still use the advertising ID to limit repeats and count ads ([Google AdMob help](https://support.google.com/admob/answer/7676680)).
- Change your choice anytime in **You → Privacy Centre → Ad choices**. You can reset or delete your advertising ID in your phone's Google settings.

---

## 9. Where your data is stored, and transfers outside India

- Your **main database is in Mumbai, India.** Our **security logs are also stored in our Mumbai (India) database.**
- Our **app server runs in Singapore**, so your data is **processed outside India** while you use the app. Planned Google services may also process data outside India.
- **IT Act / SPDI Rule 7.** We transfer SPDI only where it is needed to provide the service you signed up for, or where you consent, and only to providers that keep **at least the same level of protection** as we do — encryption, access control and contractual security duties.
- **DPDP Act section 16.** Transfers outside India are allowed unless the Government of India restricts a country. We will follow any such restriction and any requirement made under DPDP Rules, 2025, Rule 15.

---

## 10. How long we keep your data

We keep data only as long as needed for the purpose, or as long as a law requires (SPDI Rule 5(4); DPDP Act section 8(7)).

| Data | How long |
|---|---|
| Account, profile, health, Health Connect, money, insights, feature-use counts | Until you delete it or your account |
| After you delete your account | Removed from our live database straight away. Backups are kept for up to 7 days where our database plan provides them; after that, copies in backups are gone too. |
| Coach questions | **Not stored** — processed to answer, then discarded. Only a daily count is kept (until you delete your account) |
| Security logs | **1 year**, stored in our Mumbai (India) database, then deleted (covers CERT-In's 180-day rule and DPDP Rules' 1-year rule) |
| Consent records | Account life + 1 year (kept for 1 year after you delete your account, then deleted) |
| Purchase and tax records | **8 years** (GST law needs 72 months from the annual-return due date; Income-tax law also needs books kept for years) |
| Support and grievance emails | 1 year after the matter is closed |
| Bill split and calculator inputs | Never on our server |

**Inactive accounts.** If you do not open the app or contact us for **3 years**, we may delete your account. If we do, we will warn you by email **at least 48 hours before** deletion, so you can log in to keep it (DPDP Rules, 2025, Rule 8).

> **Important:** Deleting your account or uninstalling the app **does not cancel a Google Play subscription.** Cancel it first in **Google Play → Profile → Payments & subscriptions → Subscriptions**.

---

## 11. Your rights

You have these rights under the **SPDI Rules, 2011** and the **DPDP Act, 2023**:

1. **Access** — get a summary of the data we hold, what we do with it, and who we shared it with (DPDP Act s.11; SPDI Rule 5(6)).
2. **Review and correct** — fix wrong, incomplete or old data. Most data you can edit yourself in the app (DPDP Act s.12; SPDI Rule 5(6)).
3. **Erase** — ask us to delete your data, except what the law makes us keep (DPDP Act s.12(3)).
4. **Withdraw consent** — anytime, as easily as you gave it (DPDP Act s.6(4); SPDI Rule 5(7)).
5. **Grievance redressal** — complain to our Grievance Officer (DPDP Act s.13; SPDI Rule 5(9)).
6. **Nominate** — name another person to use your rights if you die or cannot act (DPDP Act s.14). Email us with their name and contact details.
7. **Complain to the Data Protection Board of India** — after first using our grievance process (DPDP Act s.13(3) and s.27). The Board works as a digital office and takes complaints online.

**How to use your rights**

- **Export your data:** **You → Privacy Centre → Export my data.**
- **Delete your account in the app:** **You → Privacy Centre → Delete account.** This deletes your account and all linked data on our server and clears RaphAi data on your phone.
- **Delete your account without the app:** go to **<https://raphai-backend.onrender.com/delete-account>**, or email [SUPPORT EMAIL] from your registered email with the subject "Delete my RaphAi account". We will check it is you and then delete it.
- **Health Connect / Physical activity / notifications:** change them in your phone settings.
- **Ads:** **You → Privacy Centre → Ad choices.**
- **Anything else** (access summary, correction, nomination, complaints): email [SUPPORT EMAIL].

We reply to rights requests within **30 days**.

---

## 12. How we protect your data (reasonable security practices)

We follow **SPDI Rule 8** and **DPDP Rules, 2025, Rule 6**. We keep a **written information security programme and policies**, modelled on the international standard **IS/ISO/IEC 27001**, with managerial, technical, operational and physical controls suited to health and money data. Our measures include:

- **Encryption in transit:** all traffic between the app, our server and the database uses HTTPS/TLS.
- **Encryption at rest:** our database provider, Supabase, encrypts all customer data at rest with **AES-256** ([Supabase security](https://supabase.com/security)).
- **Passwords:** stored only as **bcrypt** hashes. Login tokens are kept in the phone's secure storage.
- **Access control and least privilege:** only the owner can reach production systems, each system gets only the access it needs (the app uses a limited database role), and admin accounts use strong passwords and two-factor sign-in where available.
- **Logging and monitoring:** access and security events are logged, stored in our Mumbai (India) database for 1 year, and reviewed to detect and investigate misuse.
- **Backups and recovery:** backups are kept for up to 7 days where our database plan provides them, so data can be recovered if something goes wrong, without keeping deleted data longer than Section 10 says.
- **Secure development:** code review, dependency updates and fixing known vulnerabilities.
- **Contracts:** our service providers are bound to keep your data secure.
- **Clock sync:** our systems use standard time sources so logs are accurate, as CERT-In requires.

No system is 100% secure, but we work hard to protect your data and can show our controls to any authority that asks (SPDI Rule 8(1)).

---

## 13. If there is a data breach

If a security incident affects your data, we will:

- **report the cyber incident to CERT-In within 6 hours** of noticing it (CERT-In Directions of 28 April 2022);
- **tell the Data Protection Board of India without delay**, and send a **detailed report within 72 hours** (DPDP Rules, 2025, Rule 7);
- **tell you without delay**, in plain language, through the app or email: what happened, when, the likely impact on you, what we are doing, what you can do to protect yourself, and who to contact.

---

## 14. Permissions the app asks for

| Permission | Why | Can I say no? |
|---|---|---|
| Health Connect — steps, distance, active calories, exercise, heart rate, resting heart rate, sleep, weight (each asked separately) | Show your activity, sleep and progress automatically | Yes — you can log by hand instead |
| Health Connect — read in background (`READ_HEALTH_DATA_IN_BACKGROUND`) | Keep data up to date when the app is closed | Yes |
| Physical activity (`ACTIVITY_RECOGNITION`) | Count steps with the phone's sensor | Yes |
| Notifications | Reminders you set (sit, water, bills) | Yes |
| Internet | Sync with our server | Needed for the app to work |

---

## 15. Is RaphAi an "intermediary"?

RaphAi is mainly **not** an intermediary under the IT Act. It is a personal tracking app: the data you enter is for your own use and is not published to or shared with other users. If any part of RaphAi is ever treated as an intermediary (section 2(1)(w) of the IT Act), we will follow the IT (Intermediary Guidelines and Digital Media Ethics Code) Rules, 2021: we publish this policy and our Terms, and complaints about content under Rule 3(2) will be **acknowledged within 24 hours and resolved within 15 days**. That would also let us rely on the safe-harbour protection in **section 79** of the IT Act for content posted by others.

---

## 16. Changes to this policy

We may update this policy when we add features or when the law changes. We will change the "Last updated" date and version at the top. For important changes — such as a new type of data, a new purpose or a new data recipient — we will tell you in the app or by email **before** the change takes effect and, where needed, ask for your consent again.

---

## 17. Grievance Officer and contact

You can raise any question, complaint or rights request with our Grievance Officer:

**Shalem Raj Rooppa** — Grievance Officer, RaphAi
Email: [SUPPORT EMAIL]
Post: [POSTAL ADDRESS], Andhra Pradesh, India

**Our timelines:** we **acknowledge within 48 hours** and **resolve within 30 days** of receiving your complaint. This meets the one-month limit in SPDI Rule 5(9), the one-month limit in the Consumer Protection (E-Commerce) Rules, 2020 for paid plans, and the 90-day outer limit in DPDP Rules, 2025, Rule 14. If you are not satisfied, you may complain to the **Data Protection Board of India**.

---

## 18. What laws we follow

- **Information Technology Act, 2000** — section 43A (compensation for failing to protect SPDI), section 72A (no disclosure of personal information in breach of contract), section 79 (intermediary safe harbour, where relevant) and section 70B (CERT-In).
- **SPDI Rules, 2011** — Rules 3 to 8.
- **Digital Personal Data Protection Act, 2023** and **DPDP Rules, 2025** — notified on 13 November 2025 and coming into force in phases. Most duties apply **18 months after notification (May 2027)**. We follow them now. When DPDP Act section 44(2) comes into force, IT Act section 43A and the SPDI Rules will be replaced by the DPDP Act.
- **CERT-In Directions of 28 April 2022.**
- **IT (Intermediary Guidelines and Digital Media Ethics Code) Rules, 2021**, where relevant.
- **Consumer Protection Act, 2019** and **Consumer Protection (E-Commerce) Rules, 2020**, for paid plans.
- **Google Play Developer Policies**, including the Health Connect / health permissions rules and the account-deletion rule.

See the **Legal basis annex** below for the exact provisions and official sources.

---

## Annex — Legal basis

| Law / rule | What it requires | Where this policy covers it | Official source |
|---|---|---|---|
| IT Act 2000, s.43A (with Explanation: "body corporate" includes a sole proprietorship) | Compensation if a body corporate handling SPDI is negligent with reasonable security practices | Sections 1, 12 | [India Code — IT Act (updated PDF)](https://www.indiacode.nic.in/bitstream/123456789/13116/1/it_act_2000_updated.pdf) |
| IT Act 2000, s.72A | Up to 3 years' jail / ₹5 lakh fine for disclosing personal information obtained under a contract without consent | Section 7 | Same as above |
| IT Act 2000, s.79 | Safe harbour for intermediaries that follow due diligence | Section 15 | Same as above |
| IT Act 2000, s.70B(6) | CERT-In may issue binding directions | Sections 12, 13 | Same as above |
| SPDI Rules 2011, Rule 3 | SPDI includes passwords; financial information (bank/card/payment instrument details); physical, physiological and mental health condition; medical records | Summary table | [India Code — GSR 313(E)](https://upload.indiacode.nic.in/showfile?actid=AC_CEN_45_76_00001_200021_1517807324077&filename=GSR313E_10511(1)_0.pdf&type=rule) |
| SPDI Rules, Rule 4 | Publish a privacy policy listing data types, purposes, disclosures and security practices | This whole policy | Same as above |
| SPDI Rules, Rule 5 | Written consent before collecting SPDI; collect only what is needed; tell people what, why, who; keep only as long as needed; use only for the stated purpose; allow review and correction; option to refuse and to withdraw; Grievance Officer who resolves within one month | Sections 4, 5, 10, 11, 17 | Same as above |
| SPDI Rules, Rule 6 | No SPDI disclosure without prior permission, except legal obligation or written request from an authorised Government agency; no publishing; recipients must not disclose further | Section 7 | Same as above |
| SPDI Rules, Rule 7 | Transfer SPDI only to entities with the same level of protection, and only if needed for the contract or consented | Section 9 | Same as above |
| SPDI Rules, Rule 8 | Documented information security programme; IS/ISO/IEC 27001 is one such standard | Section 12 | Same as above |
| DPDP Act 2023, ss.4–6 | Lawful purpose; notice before consent (incl. how to complain to the Board; English or Eighth-Schedule language); free, specific, informed, unambiguous consent; withdrawal as easy as giving | Sections 4, 5 | [MeitY — DPDP Act PDF](https://www.meity.gov.in/static/uploads/2024/06/2bf1f0e9f04e6fb4f8fef35e82c42aa5.pdf) |
| DPDP Act, s.8 | Processors only under contract; reasonable security safeguards; breach intimation; erase when purpose ends; publish contact person; grievance mechanism | Sections 7, 10, 12, 13, 17 | Same as above |
| DPDP Act, s.9 | Children (under 18): verifiable parental consent; no tracking or targeted ads | Section 2 | Same as above |
| DPDP Act, ss.11–14 | Access, correction and erasure, grievance redressal (exhaust before going to the Board), nomination | Section 11 | Same as above |
| DPDP Act, s.16 | Cross-border transfer allowed unless restricted by notification | Section 9 | Same as above |
| DPDP Act, s.44(2) | Omits IT Act s.43A (and the SPDI Rules' rule-making power) when it commences | Section 18 | Same as above |
| DPDP commencement — G.S.R. 843(E), 13 Nov 2025 | Board provisions in force at once; most duties (ss.3–17, 44(2)) after 18 months | Section 18 | [PIB release PRID 2190014](https://www.pib.gov.in/PressReleasePage.aspx?PRID=2190014) |
| DPDP Rules 2025 (G.S.R. 846(E), 13 Nov 2025), Rule 1 | Rules 3, 5–16 apply 18 months after publication | Section 18 | [MeitY — DPDP Rules PDF](https://www.meity.gov.in/static/uploads/2025/11/53450e6e5dc0bfa85ebd78686cadad39.pdf) |
| DPDP Rules, Rule 6 | Minimum safeguards: encryption, access control, logs and monitoring, backups, keep logs 1 year, processor contracts | Sections 10, 12 | Same as above |
| DPDP Rules, Rule 7 | Tell each affected person without delay; tell the Board without delay and in detail within 72 hours | Section 13 | Same as above |
| DPDP Rules, Rule 8 | 48 hours' notice before erasure for inactivity; keep processing logs at least 1 year | Section 10 | Same as above |
| DPDP Rules, Rule 14 | Publish how to exercise rights; respond to grievances within at most 90 days; nomination | Sections 11, 17 | Same as above |
| DPDP Rules, Rule 15 | Cross-border transfer subject to Government requirements | Section 9 | Same as above |
| CERT-In Directions, 28 April 2022 (under IT Act s.70B(6)) | Report listed cyber incidents (incl. data breach, data leak, unauthorised access) within 6 hours; keep ICT logs securely for 180 days **within India**; sync clocks to NIC/NPL NTP | Sections 10, 12, 13 | [CERT-In Directions PDF](https://www.cert-in.org.in/PDF/CERT-In_Directions_70B_28.04.2022.pdf) |
| IT (Intermediary Guidelines …) Rules 2021, Rule 3 | Intermediaries publish policy and terms; Grievance Officer acknowledges within 24 hours, resolves within 15 days | Section 15 | [MeitY — Intermediary Rules (updated 6.4.2023)](https://www.meity.gov.in/static/uploads/2024/02/Information-Technology-Intermediary-Guidelines-and-Digital-Media-Ethics-Code-Rules-2021-updated-06.04.2023-.pdf) |
| Consumer Protection (E-Commerce) Rules 2020, Rule 4(4)–(5) | Grievance Officer acknowledges within 48 hours, redresses within one month | Section 17; Terms | [Dept. of Consumer Affairs — E-Commerce Rules](https://consumeraffairs.nic.in/theconsumerprotection/consumer-protection-e-commerce-rules-2020); confirmed in [Lok Sabha answer, 18.03.2026](https://fcainfoweb.nic.in/PMS/writereaddata/2026_LS_B_361.pdf) |
| CGST Act 2017, s.36 | Keep GST books and records 72 months from the annual-return due date | Section 10 | [CBIC — CGST s.36](https://taxinformation.cbic.gov.in/content/html/tax_repository/gst/acts/2017_CGST_act/active/chapter8/section36_v1.00.html) |
| Google Play — health permissions | Health data only for approved user-facing features; no ads, no selling, no credit/insurance use; encryption at rest and in transit; full privacy policy | Section 6 | [Play Console Help 12991134](https://support.google.com/googleplay/android-developer/answer/12991134) |
| Google Play — account deletion | In-app deletion path and a web link to request deletion; explain any data kept | Sections 10, 11 | [Play Console Help 13327111](https://support.google.com/googleplay/android-developer/answer/13327111) |
| Supabase security | Customer data encrypted at rest with AES-256 and in transit with TLS | Section 12 | [supabase.com/security](https://supabase.com/security) |
| Supabase backups | Pro plan keeps 7 days of daily backups (Free plan: no platform backups) | Section 10 | [Supabase backups docs](https://supabase.com/docs/guides/platform/backups) |
