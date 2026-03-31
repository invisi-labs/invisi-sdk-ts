import { usePayOpen } from "@invisi/react"

function PaymentButton() {
  const { status, calldata, error, prepare } = usePayOpen()

  const handlePay = () => {
    prepare({
      chainId: 84532n,
      identityCommitment: "0x...",
      tokenAddress: "0x...",
      amount: 100_000_000n,
      treeId: 1n,
    })
  }

  return (
    <div>
      <button onClick={handlePay} disabled={status === "preparing"}>
        {status === "preparing" ? "Preparing..." : "Pay 100 USDC"}
      </button>
      {status === "ready" && <p>Calldata ready: {calldata?.data.slice(0, 20)}...</p>}
      {status === "error" && <p>Error: {error?.message}</p>}
    </div>
  )
}

export default function App() {
  return (
    <div style={{ padding: "2rem", fontFamily: "sans-serif" }}>
      <h1>Invisi React Integration</h1>
      <p>Build payment calldata using the usePayOpen hook</p>
      <PaymentButton />
    </div>
  )
}
