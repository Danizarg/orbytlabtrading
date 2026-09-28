export default async function Page({ params }: { params: Promise<{ mint: string }> }) {
  const { mint } = await params;
  return <div className="p-6 text-muted">{mint}</div>;
}
