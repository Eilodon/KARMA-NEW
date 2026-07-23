declare module "blake2b" {
  interface Blake2bHash {
    update(input: Uint8Array): Blake2bHash;
    digest(): Uint8Array;
    digest(encoding: "hex"): string;
  }
  function blake2b(outputLength: number, key?: Uint8Array, salt?: Uint8Array, personal?: Uint8Array): Blake2bHash;
  export = blake2b;
}
