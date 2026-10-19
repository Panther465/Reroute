import { ButtonLink } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/States'
import { useDocumentTitle } from '@/lib/hooks'

export default function NotFound() {
  useDocumentTitle('Page not found')
  return (
    <div className="mx-auto max-w-[560px] px-5 pt-6">
      <h1 tabIndex={-1} className="t-display-1 text-ink">
        Page not found
      </h1>
      <EmptyState title="This page doesn't exist" body="The link may be old. Your plan is on the Today tab." action={<ButtonLink to="/">Go to Today</ButtonLink>} />
    </div>
  )
}
