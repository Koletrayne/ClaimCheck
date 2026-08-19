'use strict';

/* English locale for ClaimCheck. Registered on window.ccLocales.en.
   Keep this file as the canonical key set — other locales mirror its shape. */
(function () {
  window.ccLocales = window.ccLocales || {};
  window.ccLocales.en = {
    meta: { name: 'English' },

    a11y: {
      inputMode: 'Input mode',
      yourPrediction: 'Your prediction',
      authMode: 'Auth mode',
    },

    header: {
      language: 'Language',
      account: 'Sign in or create an account',
      accountSignedIn: 'Account — signed in as {email}',
      history: 'View claim history',
      theme: 'Toggle dark mode',
      classroom: 'Classroom',
      classroomTitle: 'Classroom Mode — temporary classrooms students join with a code',
    },

    intro: {
      title: 'ClaimCheck',
      subtitle: 'Check online claims with evidence-based analysis.',
    },

    shared: {
      text: "You're viewing a shared analysis. Edit the claim and check again to run your own.",
      dismiss: 'Dismiss',
    },

    tabs: {
      claim: 'Check a Claim',
      url: 'Analyze an Article URL',
    },

    input: {
      claimPlaceholder: 'e.g. "Drinking coffee reduces the risk of type 2 diabetes."',
      claimAria: 'Claim to check',
      claimHelper: 'Paste a claim, headline, statistic, or short paragraph. Max 8,000 characters.',
      urlPlaceholder: 'https://example.com/news/article',
      urlAria: 'Article URL to analyze',
      urlHelper: 'Paste a link to a news article or web page. ClaimCheck reads the page, identifies the main claim, and evaluates it.',
    },

    toggles: {
      academic: 'Academic sources only',
      predict: 'Predict first',
      predictTitle: 'Make your own prediction before the evidence is revealed, then compare.',
      snapshot: 'Quick snapshot',
      snapshotTitle: 'Get a faster, abbreviated rundown — verdict, confidence, one-line takeaway, and any red flag — instead of the full report.',
      context: 'Context Lens',
      contextTitle: 'Include the Context Lens — background and reflection questions that help you judge the claim fairly.',
    },

    buttons: {
      checkClaim: 'Check Claim',
      analyzeArticle: 'Analyze Article',
      quickSnapshot: 'Quick Snapshot',
      checking: 'Checking…',
      analyzing: 'Analyzing…',
      snapshotting: 'Snapshotting…',
      runFull: 'Run full analysis',
      copyShare: 'Copy share link',
      exportPdf: 'Export as PDF',
      exportWord: 'Export as Word',
      exporting: 'Exporting…',
      exportFailed: 'Export failed',
      linkCopied: 'Link copied!',
      linkInBar: 'Link in address bar',
      linkFailed: 'Could not build link',
    },

    library: {
      toggle: 'Need a claim to try? Browse examples',
      categories: {
        science: 'Science & Nature',
        health: 'Health & Nutrition',
        history: 'History & Society',
        media: 'Media & Technology',
        civic: 'Civic & Environment',
      },
      claims: {
        science: [
          'Lightning never strikes the same place twice.',
          'The Great Wall of China is visible from space with the naked eye.',
          'Antibiotics are an effective treatment for viral infections like the common cold.',
          'A goldfish has a memory span of only three seconds.',
        ],
        health: [
          'Eating carrots significantly improves your night vision.',
          'You must drink eight glasses of water a day to stay healthy.',
          'Vitamin C supplements prevent the common cold.',
          'Vaccines cause autism.',
        ],
        history: [
          'Napoleon Bonaparte was unusually short for his time.',
          'Humans only use 10 percent of their brains.',
          'People convicted in the Salem witch trials were burned at the stake.',
          'Albert Einstein failed mathematics as a student.',
        ],
        media: [
          "A browser's incognito mode makes your web activity completely anonymous.",
          '5G mobile networks spread the COVID-19 virus.',
          'Charging your phone overnight permanently damages the battery.',
          'A higher megapixel count always means a better camera.',
        ],
        civic: [
          'The United States incarcerates more people than any other country.',
          'In many markets, newly built solar and wind power is now cheaper than new coal or gas.',
          'Recycling alone can solve the ocean plastic pollution crisis.',
          'Electric cars produce zero emissions over their full lifecycle.',
        ],
      },
    },

    predict: {
      prompt: "Before you see the evidence — what's your read on this claim?",
      likelyTrue: 'Likely true',
      notSure: 'Not sure',
      likelyFalse: 'Likely false',
      hint: "Your prediction stays on this device — it's just to help you reflect.",
      recapTitle: 'Your Prediction vs. The Evidence',
      youPredicted: 'You predicted',
      evidenceSays: 'Evidence says',
      noteMatch: 'Your initial read lined up with the evidence. Notice what signals led you there — were they reliable reasons, or a lucky guess?',
      noteMismatch: 'Your initial read differed from where the evidence points. That gap is worth examining: what made the claim feel believable before you checked?',
      noteUnsure: 'You held off on judging — a reasonable instinct for an unfamiliar claim. See how the evidence resolves it below.',
      notePartial: 'You had a confident prediction, but the evidence itself is mixed or limited. Certainty in your gut does not always match the strength of available proof.',
    },

    status: {
      snapshotUrl: 'Reading the article for a quick snapshot…',
      snapshotClaim: 'Pulling together a quick snapshot…',
      url: 'Reading the article and identifying claims… this can take a little longer.',
      claim: 'Analyzing claim — this may take up to 30 seconds…',
    },

    errors: {
      claimEmpty: 'Please enter a claim to check.',
      claimShort: 'Please enter at least a few words to analyze.',
      urlEmpty: 'Please paste a URL to analyze.',
      urlInvalid: 'Please enter a valid http:// or https:// URL.',
      unexpectedResponse: 'The server returned an unexpected response ({status}).',
      analysisFailed: 'Analysis failed ({status}).',
      notConfigured: 'The analysis service is not configured. Set ANTHROPIC_API_KEY in the backend .env file.',
      backendUnreachable: 'Could not reach the ClaimCheck backend. Make sure it is running.',
      generic: 'Something went wrong while checking this claim. Please try again.',
    },

    results: {
      extractedClaim: 'Extracted Claim',
      academicPill: 'Academic',
      academicPillTitle: 'Sourced from peer-reviewed, university, and government domains only.',
      otherClaims: 'Other Claims in the Article',
      breakdown: 'Claim Breakdown',
      what: 'What',
      who: 'Who',
      when: 'When',
      where: 'Where',
      evidenceNeeded: 'Evidence needed',
      evidenceLocated: 'Evidence located',
      supporting: 'Supporting Evidence',
      contradicting: 'Contradicting Evidence',
      questions: 'Questions to Consider',
      noneFound: 'None found.',
      analyzedFrom: 'Analyzed from',
      uncertaintyPrefix: 'Uncertainty: ',
    },

    evidenceMatch: {
      found: 'Found',
      partial: 'Partially found',
      notFound: 'Not found',
    },

    verdict: {
      supported: { label: 'Supported', summary: 'Evidence broadly aligns with the claim.' },
      contradicted: { label: 'Contradicted', summary: 'Evidence broadly conflicts with the claim.' },
      unclear: { label: 'Unclear', summary: 'Evidence is mixed, limited, or inconclusive.' },
    },

    confidence: {
      high: 'High',
      medium: 'Medium',
      low: 'Low',
      suffix: '{level} confidence',
      title: 'How confident ClaimCheck is in this verdict given the evidence found.',
    },

    credibility: {
      high: 'High',
      medium: 'Medium',
      low: 'Low',
      unknown: 'Unrated',
      ariaPrefix: 'Source credibility: ',
      titleHigh: 'High credibility — peer-reviewed research, primary government/IGO data, or established academic institution.',
      titleMedium: 'Medium credibility — established journalism with editorial standards, or nonpartisan fact-checker.',
      titleLow: 'Low credibility — unclear editorial process, openly partisan outlet, opinion blog, or aggregator.',
      titleUnknown: 'Credibility could not be determined from available signals.',
    },

    snapshot: {
      labelQuick: 'Quick Snapshot',
      label: 'Snapshot',
      identityFlagged: 'Identity-targeting language flagged — see the Identity Lens.',
      noConcern: 'No identity-targeting or major concern flags.',
      footSupporting: '{n} supporting',
      footContradicting: '{n} contradicting',
      upgradeNote: 'Want the full picture — breakdown, all sources, context, and reflection questions?',
    },

    identity: {
      title: 'Identity Lens',
      flagged: 'Identity targeting detected',
      clean: 'No identity targeting detected',
      groups: 'Groups referenced',
      patterns: 'Patterns observed',
      patternFallback: 'Pattern',
    },

    context: {
      title: 'Context Lens',
      subtitle: 'Background to help you judge the claim fairly',
      fallback: 'Context could not be generated for this claim. Try checking the claim again or adding more detail.',
      background: 'Background Snapshot',
      key: 'Key Context',
      why: 'Why This Context Matters',
      missing: 'Missing or Needed Information',
      reflection: 'Reflection Questions',
    },

    meta: {
      model: 'Model: {model}',
      searchOne: '{n} web search',
      searchOther: '{n} web searches',
      academicMode: 'Academic mode',
      snapshot: 'Snapshot',
    },

    history: {
      title: 'History',
      close: 'Close history',
      loading: 'Loading your synced checks…',
      loadError: 'Could not load your synced history. Please try again.',
      emptySignedIn: 'No saved checks yet. Check a claim to see it here.',
      emptyGuest: 'No analyses yet. Check a claim to see it here.',
      clearAll: 'Clear all',
      remove: 'Remove this entry',
      countOne: '{n} entry',
      countOther: '{n} entries',
      syncedSuffix: ' · synced',
      justNow: 'Just now',
      minutesAgo: '{n}m ago',
      today: 'Today {time}',
      yesterday: 'Yesterday',
      daysAgo: '{n} days ago',
    },

    auth: {
      close: 'Close',
      signIn: 'Sign in',
      signUp: 'Sign up',
      createAccount: 'Create account',
      account: 'Account',
      continueGoogle: 'Continue with Google',
      or: 'or',
      email: 'Email',
      password: 'Password',
      confirmPassword: 'Confirm password',
      forgot: 'Forgot password?',
      resetTitle: 'Reset your password',
      resetHint: "Enter your email and we'll send you a reset link.",
      sendReset: 'Send reset link',
      backToSignIn: 'Back to sign in',
      checkInbox: 'Check your inbox',
      confirmHintBefore: 'We sent a confirmation link to ',
      confirmHintAfter: '. Click it, then return here to sign in.',
      resetSentBefore: 'We sent a password reset link to ',
      resetSentAfter: '. Click it to set a new password.',
      signedInAs: 'Signed in as',
      historySynced: 'History synced to your account',
      import: 'Import',
      importing: 'Importing…',
      importFailed: 'Import failed: ',
      signOut: 'Sign out',
      unavailable: 'Auth service unavailable.',
      credentialsRequired: 'Email and password are required.',
      passwordsMismatch: "Passwords don't match.",
      emailRequired: 'Email is required.',
      accountUnavailable: 'Account temporarily unavailable.',
      importPromptOne: 'Import {n} past check to your account?',
      importPromptOther: 'Import {n} past checks to your account?',
      errInvalidCredentials: 'Email or password is incorrect.',
      errAlreadyRegistered: 'An account with that email already exists. Try signing in.',
      errNotConfirmed: 'Please confirm your email before signing in.',
    },
  };
})();
