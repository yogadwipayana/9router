import { Card } from "@/shared/components";

export default function ModelsPage() {
  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <Card padding="md" title="Models" icon="model_training">
        <p className="text-sm text-text-muted">
          View and configure available dashboard models.
        </p>
      </Card>
    </div>
  );
}
