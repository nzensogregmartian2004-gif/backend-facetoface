-- Étape 5 : audience géographique du créateur. Additif : un index sur le pays déclaré dans le profil.
CREATE INDEX "User_country_idx" ON "User"("country");
