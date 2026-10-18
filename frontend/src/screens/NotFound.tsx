import { ButtonLink } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/States'

export default function NotFound() {
  return (
    <div className="mx-auto max-w-[560px] px-5 pt-6">
      <EmptyState title="This page doesn't exist" body="The link may be old. Your plan is on the Today tab." action={<ButtonLink to="/">Go to Today</ButtonLink>} />
    </div>
  )
}
