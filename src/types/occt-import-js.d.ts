// occt-import-js non pubblica i tipi: dichiariamo solo quello che usiamo.
declare module "occt-import-js" {
  const factory: (opts: { locateFile: () => string }) => Promise<unknown>;
  export default factory;
}
