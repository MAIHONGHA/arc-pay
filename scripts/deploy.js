async function main() {
  const USDC_ADDRESS =
    "0x3600000000000000000000000000000000000000";

  const ArcPayInvoice = await ethers.getContractFactory("ArcPayInvoice");

  const invoice = await ArcPayInvoice.deploy(USDC_ADDRESS);

  await invoice.waitForDeployment();

  console.log("ArcPayInvoice deployed to:", await invoice.getAddress());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});