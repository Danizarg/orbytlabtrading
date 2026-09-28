export default async function Page({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  return <div className="p-6 text-muted">{address}</div>;
}
