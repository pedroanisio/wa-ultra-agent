import { httpBasic } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

const password = process.env.WA_UI_PASSWORD;

if (!password) {
  // Fail at boot rather than serving an ungated agent. This one can read and
  // send WhatsApp as the user, so an open endpoint is not a lesser mistake
  // here — it hands the account to anyone who finds the port.
  throw new Error("WA_UI_PASSWORD is not set. Add it to .env before starting the agent.");
}

export default eveChannel({
  // No localDev() on purpose: it authenticates based on the process being a dev
  // server, not on who is calling, so on a LAN-bound server every device on the
  // network would get in without a password.
  auth: [
    httpBasic(
      { username: process.env.WA_UI_USERNAME ?? "me", password },
      { realm: "WhatsApp Agent" },
    ),
  ],
});
