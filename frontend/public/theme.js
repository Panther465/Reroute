// Puts a chosen light or dark theme on the page before the app loads, so it never flashes the other one.
// A file, not an inline script: the content security policy allows only scripts from this site.
try {
  var theme = JSON.parse(localStorage.getItem('reroute:prefs:v2') || '{}').theme
  if (theme === 'light' || theme === 'dark') {
    document.documentElement.setAttribute('data-theme', theme)
    var meta = document.querySelector('meta[name="theme-color"]')
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#10161F' : '#EDF0EB')
  }
} catch (e) {
  /* no storage: the system theme stands */
}
