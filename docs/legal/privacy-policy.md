# RaphAi Privacy Policy

**Effective date:** 8 October 2026
**Last updated:** 8 October 2026

This Privacy Policy explains what personal data the RaphAi app collects, why we collect it, who we share it with, how long we keep it, and the choices and rights you have. We have tried to write it in plain, simple English.

RaphAi is an Android app (package name `com.raphai.app`) that helps you track your health, fitness and personal finances in one place.

> **Short version**
> - We collect only what we need to run the app: your account, your profile, the health and money entries you make, and step data you allow us to read.
> - We **do not sell** your data. We **do not** use your data to give loans or check your credit.
> - Data from **Android Health Connect is never used for advertising**.
> - You can **export** your data and **delete your account** from inside the app at any time.
> - RaphAi is for people **18 years and older** only.

---

## 1. Who we are

RaphAi is operated by **RaphAi Technologies** [CONFIRM: full legal entity name and type, e.g. sole proprietorship / private limited company], with its registered address at [CONFIRM: registered address], Andhra Pradesh, India ("**RaphAi**", "**we**", "**us**", "**our**"). The owner is Shalem Raj Rooppa.

Under India's Digital Personal Data Protection Act, 2023 ("**DPDP Act**"), RaphAi is the **Data Fiduciary** for your personal data. You are the **Data Principal**.

**Contact and Grievance Officer**
- Name: [CONFIRM: Grievance Officer name — e.g. Shalem Raj Rooppa]
- Email: [CONFIRM: support / grievance email address]
- Postal address: [CONFIRM: registered address]

---

## 2. Who can use RaphAi

RaphAi is only for adults aged **18 years or older**. Under the DPDP Act, anyone under 18 is treated as a child, and we do not design RaphAi for children. Please do not use RaphAi if you are under 18. If we learn that we hold data of a person under 18, we will delete the account and its data.

---

## 3. What data we collect

We only collect data you give us, data you allow the app to read from your phone, and the basic records needed to run your subscription.

### 3.1 Account data
- Name and email address.
- Your password — stored only as a one-way **bcrypt hash**. We never store or see your actual password.
- A login token that keeps you signed in. It is stored in your phone's **secure storage** (encrypted storage on the device).
- **Planned:** if we add **Google sign-in** or **mobile number + OTP login**, we will also receive your Google account email/name or your mobile number through Google Firebase Authentication (see Section 6). This section will be updated when these go live.

### 3.2 Profile data
- Sex, age, height and weight.
- Activity level, fitness goal (for example lose, maintain or gain weight) and the pace you choose.
- Monthly income (used for budgeting features).
- Neck, waist and hip measurements.
- Daily step goal.
- Your **body-fat percentage** is calculated on the fly from your measurements. It is **not stored**.

### 3.3 Health and wellness logs (entered by you)
- Food logs, custom foods you create and your favourite foods.
- Water intake.
- Sleep hours and sleep quality.
- Mood (a score from 1 to 5) and an optional free-text note.
- Weight history.
- Workouts you add manually.
- Daily step counts.
- Your "sit reminder" settings (reminders to get up and move).

Some of this is **sensitive** — for example, your weight, sleep, mood and mood notes. Please only write in notes what you are comfortable storing.

### 3.4 Step and fitness data from your phone or wearable
With your permission, RaphAi reads data from your phone to count your activity:
- **Android Health Connect** — today we only read **steps** (`READ_STEPS`).
- **Phone pedometer** — if you use the phone's built-in step sensor, we ask for the **Physical activity** permission (`ACTIVITY_RECOGNITION`).

The step counts are **synced to our server** so they are saved in your account and available across devices.

**Planned:** we plan to let you read more data from Health Connect, including **distance, calories burned, heart rate, resting heart rate, sleep, exercise sessions, weight and body fat**. This data can come from wearables and apps such as Fitbit, Samsung Galaxy Watch or Garmin that write to Health Connect. We will **ask for each new permission separately** inside the app before reading it, and update this policy before it goes live. You can turn off any Health Connect permission at any time in your phone's Health Connect settings.

### 3.5 Finance data (entered by you)
- **Expenses:** amount, category, payment mode (UPI, card or cash) and an optional note.
- **Budgets** and **savings goals**.
- **Bills** and **bill payments** you record.

This data is stored on our server so you can see it across devices.

**What stays only on your phone:**
- **Bill split** — the names and amounts you enter to split a bill stay **on your device only**. We do not upload them.
- **SIP and EMI calculators** — the numbers you type are used only to show the result. **Nothing is stored.**

**What we do NOT collect:** We do not connect to your bank, read your SMS, read your UPI apps, or collect card numbers, bank account numbers or UPI IDs. We do not use your finance data for lending, credit scoring or selling financial products.

### 3.6 AI Coach chats
When you chat with the RaphAi AI Coach, we process your messages and send back a reply.
- **Today:** replies are generated by **rule-based logic on our own server**. No outside AI company sees your chats.
- **Planned:** we plan to use **Google's Gemini API** to generate smarter replies. When this is turned on, your chat message and the relevant parts of your profile and logs needed to answer (for example your goal, recent food or step totals) will be sent to Google for processing. We will show you a notice in the app before this starts (see Section 6). [CONFIRM: whether chat history is stored on the server, and for how long]

### 3.7 Purchase records
If you buy a Pro or Elite plan, Google Play handles the payment. **We never see your card or UPI details.** We receive and store from Google Play:
- the purchase token, the product (plan) you bought, the purchase state (for example active, cancelled, expired) and the expiry date.

We use this to unlock your plan and to keep records required by law.

### 3.8 Advertising data (Free plan only — planned)
If we add ads to the Free plan, they will be served by **Google AdMob**. AdMob may collect your device's **advertising ID**, IP address and basic device and app-interaction information to show and measure ads. See Section 7.

### 3.9 Technical data
Our server keeps basic **security logs** (for example IP address, time of request, and errors) to keep the service secure and fix problems.

**We do not currently use any analytics or crash-reporting tools** (no third-party analytics SDKs). If we add one, we will update this policy first.

---

## 4. Why we use your data (purposes)

| Purpose | Data used |
|---|---|
| Create and secure your account, keep you signed in | Account data, login token, security logs |
| Calculate your calorie, water, step and body-fat targets and show your progress | Profile data, health logs, step data |
| Save and sync your health and fitness logs | Health logs, step data |
| Track expenses, budgets, savings goals and bills | Finance data, monthly income |
| Give AI Coach replies and tips | Chat messages, plus relevant profile, health and finance data |
| Unlock and manage your Pro / Elite plan | Purchase records, account data |
| Show ads on the Free plan (planned) | Advertising ID and device data via AdMob — **never** Health Connect, health logs or finance data |
| Keep the service safe, prevent fraud and misuse, fix bugs | Security logs, account data |
| Answer your support requests and grievances | Account data and what you send us |
| Meet legal duties (for example tax records, responding to lawful requests) | Purchase records, logs |

**Legal basis.** We process your personal data on the basis of your **consent**, given when you sign up and when you turn on specific features (such as Health Connect, AI Coach, or personalised ads), and, where the DPDP Act allows, for **legitimate uses** such as complying with law. You can withdraw consent at any time (Section 10).

---

## 5. Health Connect data — our special promise

RaphAi follows Google Play's **Health Connect "Limited Use" requirements** ([Google Play policy](https://support.google.com/googleplay/android-developer/answer/9888170)). This means data we get from Health Connect:

- is used **only** to provide and improve the health and fitness features you see in RaphAi;
- is **never** used for advertising, ad targeting or ad measurement;
- is **never sold**;
- is **never** used to decide credit, lending or insurance eligibility;
- is **not** transferred to anyone else, except: (a) to our service providers who help run RaphAi (Section 6) under strict contracts, (b) when you ask us to (for example, when you export your data), (c) when required by law, or (d) as part of a merger or sale of the business, with the same protections;
- is **not read by humans** at RaphAi, unless you give us permission (for example when you ask for support), it is needed for security, or the law requires it.

You choose which Health Connect data RaphAi can read, and you can change this any time in **Phone Settings → Health Connect → App permissions → RaphAi**.

---

## 6. Who we share data with

We **do not sell** your personal data. We share it only with service providers ("**Data Processors**") who help us run RaphAi, and only as much as they need:

| Provider | What they do | Where |
|---|---|---|
| **Supabase** (PostgreSQL database, on Amazon Web Services) | Stores your account, profile, health, finance and purchase data | **Mumbai, India** (AWS ap-south-1) |
| **Render** | Runs our app server (API) that processes your requests | **Singapore** |
| **Expo** | Builds the app and delivers app updates | [CONFIRM: region — Expo is US-based] |
| **Google Play** | Handles subscription payments and app distribution | Google's global infrastructure |
| **Google Firebase Authentication** *(planned)* | Google sign-in and mobile OTP login | Google's global infrastructure |
| **Google Gemini API** *(planned)* | Generates AI Coach replies | Google's global infrastructure |
| **Google AdMob** *(planned, Free plan only)* | Shows ads | Google's global infrastructure |

We may also share data:
- when **required by law**, a court order or a valid government request;
- to **protect** the rights, safety or property of our users, RaphAi or the public;
- if RaphAi is **merged, bought or reorganised**, in which case your data stays protected by this policy.

Google's use of data in its own products is also governed by Google's own privacy policy: https://policies.google.com/privacy

---

## 7. Ads (Free plan only — planned)

If we add ads:
- Ads will appear **only on the Free plan**. Pro and Elite have no ads.
- Ads will **never** appear on health-logging or finance-entry screens.
- Ads will **never** use your Health Connect data, health logs or finance data.
- We will ask you to choose between:
  - **Personalised ads** — Google may use your device's advertising ID and past app activity to choose ads it thinks interest you; or
  - **Non-personalised ads** — ads are based only on the current context (such as the app and your rough, city-level location), not on your past behaviour. Even non-personalised ads may still use the advertising ID for limiting how often you see the same ad and for aggregated ad reports. ([Google AdMob help](https://support.google.com/admob/answer/7676680))
- **Personalised ads are shown only if you say yes.** You can change your choice at any time in **Settings → Privacy → Ads** [CONFIRM: exact menu path], and you can reset or delete your advertising ID in your phone's Google settings.

---

## 8. Where your data is stored and cross-border transfer

Your main database is in **Mumbai, India**. However, our app server runs in **Singapore**, so your data is **processed outside India** when you use the app. Some of our providers (Expo, and Google services when used) may also process data outside India.

The DPDP Act and DPDP Rules, 2025 allow transfers outside India unless the Government of India restricts transfers to a particular country. We will follow any such restriction. We choose providers that use strong security and contractual protections.

---

## 9. How long we keep your data

| Data | How long |
|---|---|
| Account, profile, health, finance and chat data | Until you delete your account (or until we delete an inactive account — see below) |
| After you delete your account | Removed from our live database straight away and **purged from backups within 30 days** [CONFIRM: backup purge timing with Supabase plan] |
| Security and access logs | **At least 1 year**, as required by the DPDP Rules, 2025, then deleted |
| Purchase and tax records | As long as required by Indian tax and accounting laws [CONFIRM: retention period with your accountant, typically up to 8 years] |
| Bill-split data and calculator inputs | Never on our server; bill-split data stays on your phone until you delete it or uninstall the app |

**Inactive accounts.** If your account is inactive for a long period [CONFIRM: period, e.g. 3 years], we may delete it. We will warn you by email **at least 48 hours before** deletion, so you can log in to keep it.

---

## 10. Your rights and choices

Under the DPDP Act you have the right to:

1. **Know and access** — get a summary of the data we hold and how we use it, and who we have shared it with.
2. **Correct and update** — fix wrong or incomplete data. You can edit most data yourself in the app.
3. **Erase** — ask us to delete your data.
4. **Withdraw consent** — at any time, as easily as you gave it. Withdrawing consent stops future processing, but does not affect processing done before. Some features may stop working without the data they need.
5. **Grievance redressal** — complain to our Grievance Officer. We will respond **within 90 days** at the latest (we aim to be much faster).
6. **Nominate** — name another person who can use your rights if you die or are unable to.
7. **Complain to the Data Protection Board of India** — if you are not satisfied with our response, after first using our grievance process.

**How to use your rights**

- **Export your data:** in the app, go to **Settings → Export my data** [CONFIRM: exact menu path].
- **Delete your account in the app:** go to **Settings → Delete account** [CONFIRM: exact menu path]. This deletes your account and all linked data on our server and clears the data stored in the app on your phone.
- **Delete your account without the app:** if you have uninstalled the app, email [CONFIRM: support email] from your registered email address with the subject "Delete my RaphAi account", or use our web form at [CONFIRM: account-deletion web page URL]. We will verify it is you and delete your account.
- **Health Connect:** remove permissions any time in your phone's Health Connect settings.
- **Phone pedometer:** turn off the Physical activity permission in **Phone Settings → Apps → RaphAi → Permissions**.
- **Ads:** change personalised / non-personalised ads in the app settings.
- **Everything else** (access, correction, nomination, grievances): email our Grievance Officer at [CONFIRM: support email].

> **Important:** Deleting your account or uninstalling the app **does not cancel your Google Play subscription**. Please cancel it in **Google Play → Profile → Payments & subscriptions → Subscriptions** first, so you are not charged again.

---

## 11. How we protect your data

- Data is encrypted **in transit** (HTTPS/TLS) and stored in an encrypted database [CONFIRM: encryption at rest is enabled on your Supabase plan].
- Passwords are stored only as bcrypt hashes.
- Your login token is kept in your phone's secure storage.
- Access to the database is limited to authorised people and systems, and access is logged.
- We keep security logs to detect and investigate misuse.

No system is 100% secure, but we work hard to protect your data.

**If there is a data breach**, we will inform affected users **without delay**, telling you what happened, the likely impact and what you can do, and we will report it to the **Data Protection Board of India within 72 hours** of becoming aware of it, as the DPDP Rules require.

---

## 12. Permissions the app asks for

| Permission | Why | Can I say no? |
|---|---|---|
| Health Connect — Steps (and others later, if you allow) | To show your step count and activity | Yes — you can log manually instead |
| Physical activity (`ACTIVITY_RECOGNITION`) | To count steps using your phone's sensor | Yes |
| Notifications [CONFIRM: if requested] | For sit reminders, water and bill reminders | Yes |
| Internet | To sync your data with our server | Required for the app to work |

---

## 13. Children

RaphAi is not for anyone under 18. We do not knowingly collect data from children. If you believe a child is using RaphAi, please email [CONFIRM: support email] and we will delete the account.

---

## 14. Changes to this policy

We may update this policy when we add features (such as the planned features above) or when the law changes. We will change the "Last updated" date at the top. If the change is important — for example, a new type of data or a new purpose — we will tell you in the app or by email **before** it takes effect and, where needed, ask for your consent again.

---

## 15. About Indian law

This policy is written to follow the **Digital Personal Data Protection Act, 2023** and the **Digital Personal Data Protection Rules, 2025** (notified in November 2025; most duties apply from 14 May 2027 under phased commencement — see [PIB release](https://www.pib.gov.in/PressReleasePage.aspx?PRID=2190014) and the [Rules](https://www.meity.gov.in/static/uploads/2025/11/53450e6e5dc0bfa85ebd78686cadad39.pdf)). We aim to meet these standards now, ahead of the deadlines. It also follows the **Information Technology Act, 2000** and rules made under it, and **Google Play** developer policies.

---

## 16. Contact us

Questions, requests or complaints:

**RaphAi Technologies** [CONFIRM: legal entity name]
Grievance Officer: [CONFIRM: name]
Email: [CONFIRM: support / grievance email]
Address: [CONFIRM: registered address], Andhra Pradesh, India
