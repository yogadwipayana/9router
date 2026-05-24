import { Card } from "@/shared/components";

export default function ApiKeyPage() {
  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <Card padding="md" title="API Key" icon="key">
        <p className="text-sm text-text-muted">
          Manage dashboard API keys and access credentials.
        </p>
      </Card>
    </div>
  );
}
