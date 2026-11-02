declare module "qrcode-terminal" {
  interface Options {
    small?: boolean;
  }
  function generate(text: string, options?: Options, callback?: (code: string) => void): void;
  export default { generate };
}

declare module 'better-sqlite3-multiple-ciphers' {
  import Database from 'better-sqlite3';
  export = Database;
}
