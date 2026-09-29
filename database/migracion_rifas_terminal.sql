-- ════════════════════════════════════════════════════════════════
--  Rifas de TERMINAL (2 cifras · 00–99)
--  Las rifas de 3 cifras (000–999) y 4 cifras (0000–9999) no cambian.
--  Ejecutar una sola vez en la base de datos.
-- ════════════════════════════════════════════════════════════════
BEGIN;

-- 1. Permitir cifras = 2 en rifas
ALTER TABLE rifas DROP CONSTRAINT IF EXISTS rifas_cifras_check;
ALTER TABLE rifas ADD CONSTRAINT rifas_cifras_check CHECK (cifras = ANY (ARRAY[2, 3, 4]));

COMMENT ON COLUMN rifas.cifras IS
  'Cantidad de dígitos de los números de la rifa. 2 = 00-99 (terminal). 3 = 000-999 (cuadrícula). 4 = 0000-9999 (buscador).';

-- 2. Aceptar números de 2 dígitos en las tablas ligadas a una rifa.
--    Busca los CHECK de formato de "numero" (^[0-9]{3,4}$ / ^[0-9]{3}$)
--    y los reemplaza por ^[0-9]{2,4}$ conservando el nombre.
--    Las tablas de categorías (cat_*, categoria_numeros) NO se tocan:
--    los números fijos de categoría siguen siendo de 3 cifras.
DO $$
DECLARE
  c RECORD;
BEGIN
  FOR c IN
    SELECT con.conname, cls.relname
      FROM pg_constraint con
      JOIN pg_class cls     ON cls.oid = con.conrelid
      JOIN pg_namespace nsp ON nsp.oid = cls.relnamespace
     WHERE nsp.nspname = 'public'
       AND con.contype = 'c'
       AND cls.relname IN ('ventas', 'reservas_cliente', 'numeros_vendedor',
                           'boleteria_numeros_extra', 'caja_pagos_numero')
       AND pg_get_constraintdef(con.oid) LIKE '%numero%'
       AND pg_get_constraintdef(con.oid) ~ '\{3(,4)?\}'
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', c.relname, c.conname);
    EXECUTE format($f$ALTER TABLE %I ADD CONSTRAINT %I CHECK (numero::text ~ '^[0-9]{2,4}$')$f$,
                   c.relname, c.conname);
    RAISE NOTICE 'Actualizado %.%', c.relname, c.conname;
  END LOOP;
END $$;

COMMIT;
