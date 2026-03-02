import React from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import Layout from './components/Layout.jsx'
import HomePage from './pages/HomePage.jsx'
import SearchPage from './pages/SearchPage.jsx'
import BrowsePage from './pages/BrowsePage.jsx'
import StreamPage from './pages/StreamPage.jsx'
import DetailPage from './pages/DetailPage.jsx'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<HomePage />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/browse/:type" element={<BrowsePage />} />
          <Route path="/title/:type/:id" element={<DetailPage />} />
        </Route>
        <Route path="/stream/:id" element={<StreamPage />} />
      </Routes>
    </BrowserRouter>
  )
}
