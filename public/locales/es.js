'use strict';

/* Spanish (Español) locale for ClaimCheck. Registered on window.ccLocales.es.
   Neutral Latin American Spanish, aimed at students and educators in the U.S.
   Mirrors the key shape of en.js. */
(function () {
  window.ccLocales = window.ccLocales || {};
  window.ccLocales.es = {
    meta: { name: 'Español' },

    a11y: {
      inputMode: 'Modo de entrada',
      yourPrediction: 'Tu predicción',
      authMode: 'Modo de autenticación',
    },

    header: {
      language: 'Idioma',
      account: 'Inicia sesión o crea una cuenta',
      accountSignedIn: 'Cuenta — sesión iniciada como {email}',
      history: 'Ver historial de afirmaciones',
      theme: 'Cambiar modo oscuro',
      classroom: 'Aula',
      classroomTitle: 'Modo Aula — aulas temporales a las que los estudiantes entran con un código',
    },

    intro: {
      title: 'ClaimCheck',
      subtitle: 'Verifica afirmaciones en línea con un análisis basado en evidencia.',
    },

    shared: {
      text: 'Estás viendo un análisis compartido. Edita la afirmación y verifícala de nuevo para hacer el tuyo.',
      dismiss: 'Descartar',
    },

    tabs: {
      claim: 'Verificar una afirmación',
      url: 'Analizar un artículo por URL',
    },

    input: {
      claimPlaceholder: 'p. ej. "Tomar café reduce el riesgo de diabetes tipo 2."',
      claimAria: 'Afirmación por verificar',
      claimHelper: 'Pega una afirmación, un titular, una estadística o un párrafo corto.',
      urlPlaceholder: 'https://ejemplo.com/noticias/articulo',
      urlAria: 'URL del artículo por analizar',
      urlHelper: 'Pega el enlace de una noticia o página web. ClaimCheck lee la página, identifica la afirmación principal y la evalúa.',
    },

    toggles: {
      academic: 'Solo fuentes académicas',
      predict: 'Predice primero',
      predictTitle: 'Haz tu propia predicción antes de ver la evidencia y luego compara.',
      snapshot: 'Vistazo rápido',
      snapshotTitle: 'Obtén un resumen breve y más rápido — veredicto, confianza, una conclusión en una línea y cualquier señal de alerta — en lugar del informe completo.',
      context: 'Lente de contexto',
      contextTitle: 'Incluye la Lente de contexto — antecedentes y preguntas de reflexión que te ayudan a evaluar la afirmación de forma justa.',
    },

    buttons: {
      checkClaim: 'Verificar afirmación',
      analyzeArticle: 'Analizar artículo',
      quickSnapshot: 'Vistazo rápido',
      checking: 'Verificando…',
      analyzing: 'Analizando…',
      snapshotting: 'Preparando vistazo…',
      runFull: 'Ejecutar análisis completo',
      copyShare: 'Copiar enlace para compartir',
      exportPdf: 'Exportar como PDF',
      exportWord: 'Exportar como Word',
      exporting: 'Exportando…',
      exportFailed: 'Falló la exportación',
      linkCopied: '¡Enlace copiado!',
      linkInBar: 'Enlace en la barra de direcciones',
      linkFailed: 'No se pudo crear el enlace',
    },

    library: {
      toggle: '¿Necesitas una afirmación para probar? Explora ejemplos',
      categories: {
        science: 'Ciencia y naturaleza',
        health: 'Salud y nutrición',
        history: 'Historia y sociedad',
        media: 'Medios y tecnología',
        civic: 'Civismo y medio ambiente',
      },
      claims: {
        science: [
          'Un rayo nunca cae dos veces en el mismo lugar.',
          'La Gran Muralla China se ve desde el espacio a simple vista.',
          'Los antibióticos son un tratamiento eficaz para infecciones virales como el resfriado común.',
          'Un pez dorado tiene una memoria de solo tres segundos.',
        ],
        health: [
          'Comer zanahorias mejora notablemente la visión nocturna.',
          'Hay que tomar ocho vasos de agua al día para estar sano.',
          'Los suplementos de vitamina C previenen el resfriado común.',
          'Las vacunas causan autismo.',
        ],
        history: [
          'Napoleón Bonaparte era inusualmente bajo para su época.',
          'Los seres humanos solo usan el 10 por ciento de su cerebro.',
          'Las personas condenadas en los juicios de brujas de Salem fueron quemadas en la hoguera.',
          'Albert Einstein reprobó matemáticas cuando era estudiante.',
        ],
        media: [
          'El modo incógnito de un navegador hace que tu actividad web sea completamente anónima.',
          'Las redes móviles 5G propagan el virus de la COVID-19.',
          'Cargar el teléfono toda la noche daña la batería de forma permanente.',
          'Más megapíxeles siempre significa una mejor cámara.',
        ],
        civic: [
          'Estados Unidos encarcela a más personas que cualquier otro país.',
          'En muchos mercados, la nueva energía solar y eólica ya es más barata que el nuevo carbón o gas.',
          'El reciclaje por sí solo puede resolver la crisis de plástico en los océanos.',
          'Los autos eléctricos no producen emisiones durante todo su ciclo de vida.',
        ],
      },
    },

    predict: {
      prompt: 'Antes de ver la evidencia, ¿qué opinas de esta afirmación?',
      likelyTrue: 'Probablemente cierta',
      notSure: 'No estoy seguro',
      likelyFalse: 'Probablemente falsa',
      hint: 'Tu predicción se queda en este dispositivo — es solo para ayudarte a reflexionar.',
      recapTitle: 'Tu predicción frente a la evidencia',
      youPredicted: 'Tú predijiste',
      evidenceSays: 'La evidencia dice',
      noteMatch: 'Tu impresión inicial coincidió con la evidencia. Fíjate qué señales te llevaron ahí: ¿fueron razones confiables o una suposición afortunada?',
      noteMismatch: 'Tu impresión inicial fue distinta de lo que indica la evidencia. Vale la pena examinar esa diferencia: ¿qué hizo que la afirmación pareciera creíble antes de verificarla?',
      noteUnsure: 'Preferiste no juzgar todavía — un instinto razonable ante una afirmación desconocida. Observa abajo cómo la resuelve la evidencia.',
      notePartial: 'Tenías una predicción firme, pero la evidencia en sí es mixta o limitada. La certeza en tu intuición no siempre coincide con la solidez de las pruebas disponibles.',
    },

    status: {
      snapshotUrl: 'Leyendo el artículo para un vistazo rápido…',
      snapshotClaim: 'Preparando un vistazo rápido…',
      url: 'Leyendo el artículo e identificando afirmaciones… esto puede tardar un poco más.',
      claim: 'Analizando la afirmación — esto puede tardar hasta 30 segundos…',
    },

    errors: {
      claimEmpty: 'Escribe una afirmación para verificar.',
      claimShort: 'Escribe al menos unas cuantas palabras para analizar.',
      urlEmpty: 'Pega una URL para analizar.',
      urlInvalid: 'Ingresa una URL válida que empiece con http:// o https://.',
      unexpectedResponse: 'El servidor devolvió una respuesta inesperada ({status}).',
      analysisFailed: 'El análisis falló ({status}).',
      notConfigured: 'El servicio de análisis no está configurado. Define ANTHROPIC_API_KEY en el archivo .env del backend.',
      backendUnreachable: 'No se pudo conectar con el backend de ClaimCheck. Asegúrate de que esté en ejecución.',
      generic: 'Algo salió mal al verificar esta afirmación. Inténtalo de nuevo.',

      // Barreras de uso. {max} y {limit} vienen de los números del servidor.
      claimTooLong: 'Las afirmaciones pueden tener hasta {max} caracteres. Intenta reducirlo a la afirmación específica que quieres verificar.',
      studentLimit: 'Has alcanzado el límite de {limit} afirmaciones para esta sesión de clase. Pregunta a tu docente si necesitas más ClaimChecks.',
      studentLimitGeneric: 'Has usado todos tus ClaimChecks para esta sesión de clase. Pregunta a tu docente si necesitas más.',
      classroomLimit: 'Esta clase alcanzó su límite de uso de ClaimCheck. Pide ayuda a tu docente.',
      globalLimit: 'ClaimCheck no está disponible temporalmente porque se alcanzó el límite de uso. Inténtalo más tarde o comunícate con tu docente.',
      usageUnverified: 'ClaimCheck no puede verificar los límites de uso en este momento. Inténtalo de nuevo en unos minutos.',
    },

    classroom: {
      claimsRemaining: '{remaining} de {limit} ClaimChecks disponibles',
    },

    results: {
      extractedClaim: 'Afirmación extraída',
      academicPill: 'Académico',
      academicPillTitle: 'Obtenido únicamente de dominios académicos, universitarios y gubernamentales revisados por pares.',
      otherClaims: 'Otras afirmaciones del artículo',
      breakdown: 'Desglose de la afirmación',
      what: 'Qué',
      who: 'Quién',
      when: 'Cuándo',
      where: 'Dónde',
      evidenceNeeded: 'Evidencia necesaria',
      evidenceLocated: 'Evidencia localizada',
      supporting: 'Evidencia a favor',
      contradicting: 'Evidencia en contra',
      questions: 'Preguntas para reflexionar',
      noneFound: 'No se encontró ninguna.',
      analyzedFrom: 'Analizado desde',
      uncertaintyPrefix: 'Incertidumbre: ',
    },

    evidenceMatch: {
      found: 'Encontrada',
      partial: 'Parcialmente encontrada',
      notFound: 'No encontrada',
    },

    verdict: {
      supported: { label: 'Respaldada', summary: 'La evidencia coincide en general con la afirmación.' },
      contradicted: { label: 'Cuestionada', summary: 'La evidencia contradice en general la afirmación.' },
      unclear: { label: 'No está claro', summary: 'La evidencia es mixta, limitada o no concluyente.' },
    },

    confidence: {
      high: 'Alta',
      medium: 'Media',
      low: 'Baja',
      suffix: 'confianza {level}',
      title: 'Qué tan segura está ClaimCheck de este veredicto según la evidencia encontrada.',
    },

    credibility: {
      high: 'Alta',
      medium: 'Media',
      low: 'Baja',
      unknown: 'Sin calificar',
      ariaPrefix: 'Credibilidad de la fuente: ',
      titleHigh: 'Credibilidad alta — investigación revisada por pares, datos primarios de gobiernos u organismos intergubernamentales, o una institución académica reconocida.',
      titleMedium: 'Credibilidad media — periodismo consolidado con estándares editoriales, o verificador de datos no partidista.',
      titleLow: 'Credibilidad baja — proceso editorial poco claro, medio abiertamente partidista, blog de opinión o agregador.',
      titleUnknown: 'No se pudo determinar la credibilidad con las señales disponibles.',
    },

    sourceType: {
      peer_reviewed: 'Revista académica',
      preprint: 'Preprint',
      government: 'Informe gubernamental',
      intergovernmental: 'Organismo internacional',
      academic_institution: 'Investigación universitaria',
      news: 'Reportaje periodístico',
      fact_check: 'Verificación de datos',
      advocacy: 'Grupo de incidencia',
      industry: 'Fuente de la industria',
      other: 'Otra fuente',
      title: {
        peer_reviewed: 'Publicado en una revista académica revisada por pares — otros expertos la evaluaron antes de publicarla.',
        preprint: 'Publicado en un servidor de preprints y AÚN NO revisado por pares. Considera los hallazgos como provisionales.',
        government: 'Publicado por una agencia gubernamental — sus propios datos, informes o estadísticas.',
        intergovernmental: 'Publicado por un organismo formado por varios gobiernos, como la OMS, la ONU o la OCDE.',
        academic_institution: 'Publicado por una universidad o instituto de investigación, pero no en una revista revisada por pares.',
        news: 'Un medio de comunicación que informa sobre el tema. Pregúntate sobre qué fuente original está informando.',
        fact_check: 'Una organización dedicada a verificar afirmaciones.',
        advocacy: 'Una organización que existe para promover una postura — un centro de estudios, un grupo de campaña o una asociación gremial.',
        industry: 'Una empresa que publica sobre su propio producto o sector.',
        other: 'No se pudo determinar el tipo de fuente.',
      },
    },

    relevance: {
      related: 'Responde a una pregunta relacionada, no a esta afirmación:',
      background: 'Contexto sobre el tema — no pone a prueba esta afirmación:',
      noticeHead: 'Ninguna fuente pone a prueba esta afirmación directamente',
      noticeBody: 'Todas las fuentes encontradas responden a una pregunta relacionada pero distinta, así que este veredicto es provisional. Lee qué aborda realmente cada fuente antes de sacar una conclusión.',
    },

    filter: {
      headOne: 'El modo académico eliminó 1 fuente',
      headOther: 'El modo académico eliminó {n} fuentes',
      body: 'Estas fuentes quedaron fuera del registro académico, gubernamental e intergubernamental al que se limita el modo académico. Desactiva el modo académico para ver qué decían.',
      domains: 'Eliminadas de: {domains}',
    },

    snapshot: {
      labelQuick: 'Vistazo rápido',
      label: 'Vistazo',
      identityFlagged: 'La afirmación misma ataca a un grupo de identidad — consulta la Lente de identidad.',
      identityAbout: 'Esta afirmación trata sobre la identidad, pero no ataca a ningún grupo.',
      noConcern: 'Sin señales de ataque a la identidad ni otras preocupaciones importantes.',
      footSupporting: '{n} a favor',
      footContradicting: '{n} en contra',
      upgradeNote: '¿Quieres el panorama completo — desglose, todas las fuentes, contexto y preguntas de reflexión?',
    },

    identity: {
      title: 'Lente de identidad',
      subtitle: 'Dos preguntas distintas: ¿la afirmación trata sobre la identidad y la afirmación misma ataca a un grupo? Una afirmación puede informar sobre el odio sin contenerlo.',
      readout: 'Trata sobre la identidad: {about} · Ataca a un grupo: {targeting}',
      yes: 'Sí',
      no: 'No',
      flagged: 'La afirmación ataca a un grupo de identidad',
      about: 'Trata sobre la identidad — sin lenguaje de ataque',
      clean: 'No se relaciona con la identidad',
      groups: 'Grupos mencionados',
      patterns: 'Patrones observados',
      patternFallback: 'Patrón',
    },

    context: {
      title: 'Lente de contexto',
      subtitle: 'Antecedentes que te ayudan a evaluar la afirmación de forma justa',
      fallback: 'No se pudo generar contexto para esta afirmación. Intenta verificarla de nuevo o agrega más detalles.',
      background: 'Resumen de antecedentes',
      key: 'Contexto clave',
      why: 'Por qué importa este contexto',
      missing: 'Información faltante o necesaria',
      reflection: 'Preguntas de reflexión',
    },

    meta: {
      model: 'Modelo: {model}',
      searchOne: '{n} búsqueda web',
      searchOther: '{n} búsquedas web',
      academicMode: 'Modo académico',
      snapshot: 'Vistazo',
    },

    history: {
      title: 'Historial',
      close: 'Cerrar historial',
      loading: 'Cargando tus verificaciones sincronizadas…',
      loadError: 'No se pudo cargar tu historial sincronizado. Inténtalo de nuevo.',
      emptySignedIn: 'Aún no hay verificaciones guardadas. Verifica una afirmación para verla aquí.',
      emptyGuest: 'Aún no hay análisis. Verifica una afirmación para verlo aquí.',
      clearAll: 'Borrar todo',
      remove: 'Eliminar esta entrada',
      countOne: '{n} entrada',
      countOther: '{n} entradas',
      syncedSuffix: ' · sincronizado',
      justNow: 'Justo ahora',
      minutesAgo: 'hace {n} min',
      today: 'Hoy {time}',
      yesterday: 'Ayer',
      daysAgo: 'hace {n} días',
    },

    auth: {
      close: 'Cerrar',
      signIn: 'Iniciar sesión',
      signUp: 'Crear cuenta',
      createAccount: 'Crear cuenta',
      account: 'Cuenta',
      continueGoogle: 'Continuar con Google',
      or: 'o',
      email: 'Correo electrónico',
      password: 'Contraseña',
      confirmPassword: 'Confirmar contraseña',
      forgot: '¿Olvidaste tu contraseña?',
      resetTitle: 'Restablece tu contraseña',
      resetHint: 'Ingresa tu correo y te enviaremos un enlace para restablecerla.',
      sendReset: 'Enviar enlace de restablecimiento',
      backToSignIn: 'Volver a iniciar sesión',
      checkInbox: 'Revisa tu bandeja de entrada',
      confirmHintBefore: 'Enviamos un enlace de confirmación a ',
      confirmHintAfter: '. Haz clic en él y luego vuelve aquí para iniciar sesión.',
      resetSentBefore: 'Enviamos un enlace para restablecer la contraseña a ',
      resetSentAfter: '. Haz clic en él para crear una nueva contraseña.',
      signedInAs: 'Sesión iniciada como',
      historySynced: 'Historial sincronizado con tu cuenta',
      import: 'Importar',
      importing: 'Importando…',
      importFailed: 'Falló la importación: ',
      signOut: 'Cerrar sesión',
      unavailable: 'El servicio de autenticación no está disponible.',
      credentialsRequired: 'El correo y la contraseña son obligatorios.',
      passwordsMismatch: 'Las contraseñas no coinciden.',
      emailRequired: 'El correo es obligatorio.',
      accountUnavailable: 'Cuenta temporalmente no disponible.',
      importPromptOne: '¿Importar {n} verificación anterior a tu cuenta?',
      importPromptOther: '¿Importar {n} verificaciones anteriores a tu cuenta?',
      errInvalidCredentials: 'El correo o la contraseña son incorrectos.',
      errAlreadyRegistered: 'Ya existe una cuenta con ese correo. Intenta iniciar sesión.',
      errNotConfirmed: 'Confirma tu correo antes de iniciar sesión.',
    },
  };
})();
