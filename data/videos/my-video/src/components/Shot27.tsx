import {
	AbsoluteFill,
	interpolate,
	useCurrentFrame,
	useVideoConfig,
	Img,
	staticFile,
	Audio,
	Easing,
} from 'remotion';
import React from 'react';

export const Shot27: React.FC = () => {
	const frame = useCurrentFrame();
	const {durationInFrames} = useVideoConfig();

	// Timeline scaling: 6.77s total
	// Transition start/end based on 0-6s (cold) -> 6-12s (warm) ratio
	// 50% split approx
	const splitFrame = Math.round(durationInFrames / 2);

	// Transition Progress
	const warmProgress = interpolate(
		frame,
		[splitFrame - 20, splitFrame + 40],
		[0, 1],
		{easing: Easing.inOut(Easing.quad), extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}
	);

	// Visual Effects
	const coldFilter = interpolate(warmProgress, [0, 1], [1, 0]); // Opacity of cold overlay
	const warmFilter = interpolate(warmProgress, [0, 1], [0, 0.6]); // Opacity of warm overlay
	
	const zoom = interpolate(warmProgress, [0, 1], [1, 1.15]); // Slight zoom in "closer"
	const blur = interpolate(warmProgress, [0, 0.5, 1], [0, 2, 0]); // Transition blur

	// Text Overlay
	const textOpacity = interpolate(warmProgress, [0.5, 1], [0, 1]);

	return (
		<AbsoluteFill style={{backgroundColor: '#000'}}>
			{/* Main Image */}
			<AbsoluteFill
				style={{
					transform: `scale(${zoom})`,
					filter: `blur(${blur}px)`,
				}}
			>
				<Img
					src={staticFile('real_family_warm.png')}
					style={{
						width: '100%',
						height: '100%',
						objectFit: 'cover',
					}}
				/>
			</AbsoluteFill>

			{/* Cold Atmosphere Overlay (Blue) */}
			<AbsoluteFill
				style={{
					backgroundColor: 'rgba(0, 50, 100, 0.6)',
					mixBlendMode: 'multiply',
					opacity: coldFilter,
				}}
			/>
			<AbsoluteFill
				style={{
					backgroundColor: 'rgba(0, 100, 200, 0.2)',
					mixBlendMode: 'overlay',
					opacity: coldFilter,
				}}
			/>

			{/* Warm Atmosphere Overlay (Gold/Orange) */}
			<AbsoluteFill
				style={{
					backgroundColor: 'rgba(255, 150, 50, 0.3)',
					mixBlendMode: 'soft-light',
					opacity: warmFilter,
				}}
			/>
			<AbsoluteFill
				style={{
					background: 'radial-gradient(circle, rgba(255, 200, 100, 0.3) 0%, transparent 70%)',
					mixBlendMode: 'screen',
					opacity: warmFilter,
				}}
			/>

			{/* Overlay Text */}
			<AbsoluteFill className="justify-end items-center pb-20">
				<div 
					className="bg-orange-100/90 px-8 py-3 rounded-full shadow-lg border-2 border-orange-300"
					style={{opacity: textOpacity, transform: `translateY(${interpolate(textOpacity, [0, 1], [20, 0])}px)`}}
				>
					<h2 
						className="text-orange-900 text-3xl font-serif italic"
						style={{fontFamily: 'Inter, sans-serif'}}
					>
						Фактическое создание семьи
					</h2>
				</div>
			</AbsoluteFill>

			<Audio src={staticFile('shot27_voice.mp3')} />
		</AbsoluteFill>
	);
};
