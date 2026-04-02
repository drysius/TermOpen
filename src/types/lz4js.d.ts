declare module "lz4js" {
  interface Lz4Js {
    compress(input: Uint8Array | number[]): Uint8Array | number[];
    decompress(input: Uint8Array | number[]): Uint8Array | number[];
  }

  const lz4: Lz4Js;
  export default lz4;
}

