import { Schema } from "effect";
import { commandResult, type BrowserCommands } from "./commands.ts";

/** Only stage/identity metadata leaves this reader, never input values or page text. */
const loginScreenScript = `JSON.stringify((()=>{
 const visible=e=>!!e&&!!(e.getBoundingClientRect().width&&e.getBoundingClientRect().height)&&!e.disabled&&!e.readOnly&&getComputedStyle(e).visibility!=='hidden'&&getComputedStyle(e).display!=='none';
 const input=s=>Array.from(document.querySelectorAll(s)).find(visible);
 const handle=document.querySelector('[data-testid="AppTabBar_Profile_Link"]')?.getAttribute('href')?.slice(1)??null;
 const heading=Array.from(document.querySelectorAll('h1,h2,[role="heading"]')).map(e=>e.textContent).join(' ');
 const codeHeading=/authentication code|confirmation code|verification code|backup code|recovery code|two.factor|인증.?코드|백업.?코드|복구.?코드|確認コード|認証コード/i.test(heading);
 const rejected=Array.from(document.querySelectorAll('[role="alert"]')).some(e=>/incorrect|wrong password|could not|couldn't|try again|잘못|일치하지|다시 시도|正しくありません/i.test(e.textContent??''));
 let field,stage='loading';
 if(handle)stage='authenticated';
 else if(rejected)stage='rejected';
 else if(input('iframe[src*="arkoselabs"],iframe[src*="hcaptcha"],[data-testid="captcha"]'))stage='manual';
 else if(field=input('input[autocomplete="one-time-code"],input[name="challenge_response"]'))stage='code';
 else if(field=input('input[type="password"]'))stage=codeHeading?'code':'password';
 else if(field=input('input[autocomplete="username"],input[name="text"],input[data-testid="ocfEnterTextTextInput"]'))stage=codeHeading?'code':/phone number or username|사용자.?이름.*확인/i.test(heading)?'identity':'username';
 document.querySelectorAll('[data-renai-auth-input]').forEach(e=>e.removeAttribute('data-renai-auth-input'));
 if(field)field.setAttribute('data-renai-auth-input','true');
 const button=Array.from(document.querySelectorAll('button,[role="button"]')).find(e=>visible(e)&&/^(Next|다음|次へ|Log in|로그인|ログイン|Verify|인증|확인|認証)$/.test((e.textContent??'').trim()));
 document.querySelectorAll('[data-renai-auth-submit]').forEach(e=>e.removeAttribute('data-renai-auth-submit'));
 if(button)button.setAttribute('data-renai-auth-submit','true');
 return {stage,handle,origin:location.origin,path:location.pathname,submit:!!button};
})())`;
const Screen = Schema.fromJsonString(
  Schema.Struct({
    stage: Schema.Literals([
      "loading",
      "authenticated",
      "username",
      "password",
      "identity",
      "code",
      "manual",
      "rejected",
    ]),
    handle: Schema.NullOr(Schema.String),
    origin: Schema.String,
    path: Schema.String,
    submit: Schema.Boolean,
  }),
);
const Batch = Schema.fromJsonString(
  Schema.NonEmptyArray(Schema.Struct({ success: Schema.Boolean })).check(Schema.isMaxLength(1)),
);

export function loginPage(
  commands: BrowserCommands,
  account: string,
  port: number,
  signal: AbortSignal,
) {
  const command = async (...args: string[]) => {
    signal.throwIfAborted();
    const output = await commands.command(account, port, args, signal);
    commandResult(output);
    return output;
  };
  return {
    open: () => command("open", "https://x.com/i/flow/login"),
    screen: async () =>
      Schema.decodeUnknownSync(Screen)(commandResult(await command("eval", loginScreenScript))),
    wait: () => command("wait", "250"),
    enter: async (value: string) => {
      signal.throwIfAborted();
      // One synchronous, origin-bound DOM operation prevents redirects between checking and filling.
      const script = `(()=>{if(location.origin!=='https://x.com'||!location.pathname.startsWith('/i/flow/login'))throw Error('Wrong login origin');const e=document.querySelector('[data-renai-auth-input]');if(!e||!e.isConnected||e.disabled)throw Error('Login input changed');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return 'filled'})()`;
      const output = await commands.command(
        account,
        port,
        ["batch", "--bail", "--omit-command"],
        signal,
        JSON.stringify([["eval", script]]),
      );
      try {
        if (!Schema.decodeUnknownSync(Batch)(output).every((row) => row.success))
          throw new Error("Private input failed");
      } catch {
        throw new Error("Private login input failed");
      }
      await command("click", '[data-renai-auth-submit="true"]');
    },
  };
}
